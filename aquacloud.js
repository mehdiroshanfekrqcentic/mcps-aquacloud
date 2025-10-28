const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { isInitializeRequest } = require("@modelcontextprotocol/sdk/types.js");
const z = require('zod');
const { randomUUID } = require('crypto');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const express = require("express");
const cors = require("cors");

const aquaUtils = require('./aquaUtils.js'); // Assuming this file is in the same directory

// --- Configuration ---
const PORT = process.env.AQUA_MCP_PORT || 5005;

// --- Server Initialization ---
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(cors({
    origin: '*',
    exposedHeaders: ['Mcp-Session-Id'],
    allowedHeaders: [
        'Content-Type', 'mcp-session-id', 'X-API-KEY', 'x-mapping-id', 'x-task-id',
        'x-user-query', 'x-project-id', 'x-aqua-username', 'x-aqua-password',
        'x-aqua-url', 'x-aqua-projectid'
    ],
}));

// In-memory store for session data, keyed by session ID.
const sessionTransports = {};
const sessionMemoryStore = {};

/**
 * Parses a raw Aqua item ID (which may have a prefix) into its numeric ID and item type.
 * @param {string} rawId - The raw ID string (e.g., "DF012345" or "12345").
 * @param {string | null | undefined} [explicitType] - The explicitly provided item type, if any.
 * @returns {{itemId: string, itemType: string}}
 * @throws {Error} if the item type cannot be determined.
 */
function parseAquaItemId(rawId, explicitType) {
    if (!rawId || typeof rawId !== 'string') {
        throw new Error("Invalid or missing item ID provided to parser.");
    }

    let finalId = rawId;
    let finalType = explicitType;
    let prefixType = null;

    // Regex to find a prefix (RQ, TC, DF), followed by optional zeros/digits, and capture the main numeric ID part
    const rqMatch = rawId.match(/^[rR][qQ](\d+)$/);
    const tcMatch = rawId.match(/^[tT][cC](\d+)$/);
    const dfMatch = rawId.match(/^[dD][fF](\d+)$/);

    if (rqMatch && rqMatch[1]) {
        prefixType = 'Requirement';
        finalId = rqMatch[1]; // The captured numeric part
    } else if (tcMatch && tcMatch[1]) {
        prefixType = 'TestCase';
        finalId = tcMatch[1];
    } else if (dfMatch && dfMatch[1]) {
        prefixType = 'Defect';
        finalId = dfMatch[1];
    }
    // If no match, finalId remains the original rawId

    if (!finalType) {
        if (prefixType) {
            finalType = prefixType; // Infer type from prefix if no explicit type was given
        } else {
            // No explicit type, and no prefix found. We cannot determine the type.
            throw new Error(`Could not determine itemType for ID "${rawId}". Please provide an explicit 'itemType' or use an ID with a recognized prefix (e.g., DF0123, RQ0123, TC0123).`);
        }
    }
    console.log(finalId, finalType)

    // Return the numeric ID and the determined item type
    // If explicitType was provided, it wins.
    // If rawId was "DF0123" and explicitType was "Requirement",
    // this returns { itemId: "0123", itemType: "Requirement" }
    return { itemId: finalId, itemType: finalType };
}


/**
 * Ensures the AquaCloud auth token is valid, refreshing if necessary.
 * @param {object} sessionMemory - The session's in-memory store.
 * @returns {Promise<object>} An authentication object for aquaUtils.
 */
async function getAquaAuth(sessionMemory) {
    if (!sessionMemory.user) throw new Error("User not found in session.");

    if (sessionMemory.aquaAuth && sessionMemory.aquaAuth.expires_at > Date.now()) {
        return { token: sessionMemory.aquaAuth.token, type: 'bearer' };
    }

    const aquaUrl = sessionMemory.user.aquacloud_url;

    // Try to refresh the token first
    if (sessionMemory.aquaAuth && sessionMemory.aquaAuth.refresh_token) {
        try {
            console.log(`[Aqua-MCP-Standalone] Refreshing Aqua token for user ${sessionMemory.user.aquacloud_username}...`);
            const tokenData = await aquaUtils.refreshToken(aquaUrl, sessionMemory.aquaAuth.refresh_token);
            sessionMemory.aquaAuth = {
                token: tokenData.access_token,
                refresh_token: tokenData.refresh_token,
                expires_at: Date.now() + (tokenData.expires_in * 1000) - 60000, // 60s buffer
            };
            return { token: sessionMemory.aquaAuth.token, type: 'bearer' };
        } catch (error) {
            console.warn(`[Aqua-MCP-Standalone] Token refresh failed for ${sessionMemory.user.aquacloud_username}. Will attempt to log in again. Error:`, error.message);
        }
    }

    // Fallback to full login
    console.log(`[Aqua-MCP-Standalone] Performing full Aqua login for user ${sessionMemory.user.aquacloud_username}...`);
    const password = sessionMemory.user.aquacloud_password;
    const tokenData = await aquaUtils.login(aquaUrl, sessionMemory.user.aquacloud_username, password);
    sessionMemory.aquaAuth = {
        token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_at: Date.now() + (tokenData.expires_in * 1000) - 60000, // 60s buffer
    };
    return { token: sessionMemory.aquaAuth.token, type: 'bearer' };
}


/**
 * Creates and configures a new McpServer instance for Aqua Cloud operations.
 * @param {object} sessionMemory - A reference to the session's in-memory store.
 * @returns {McpServer} A configured McpServer instance.
 */
function createMcpServer(sessionMemory) {
    const server = new McpServer({
        name: "aquacloud-agent-server-standalone",
        version: "1.0.0"
    });

    // This wrapper handles auth and catches errors, including parsing errors
    const withAuth = async (toolFn) => {
        try {
            const auth = await getAquaAuth(sessionMemory);
            const aquaUrl = sessionMemory.user.aquacloud_url;
            return await toolFn(auth, aquaUrl);
        } catch (error) {
            // This will catch errors from parseAquaItemId as well
            const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
            console.error(`[Aqua-MCP-Standalone] Tool execution error:`, error.message);
            return { content: [{ type: "text", text: `Error: ${errorMessage}` }] };
        }
    };

    server.registerTool("aquacloud_get-item-details", {
        title: "Get Aqua Cloud Item Details",
        description: "Fetches the full details of an Aqua Cloud work item (e.g., Requirement, Defect, TestCase).",
        inputSchema: {
            itemId: z.string().optional().describe("The ID of the item, with or without its prefix (e.g., 'DF068415' or '68415'). Defaults to the task ID from the session."),
            itemType: z.string().optional().describe("The type of the item (e.g., 'Requirement', 'Defect'). If omitted, the type will be inferred from the itemId prefix."),
        }
    }, (input) => withAuth(async (auth, aquaUrl) => {
        const rawItemId = input.itemId || sessionMemory.taskId; // Use session task ID as fallback
        if (!rawItemId) {
            return { content: [{ type: "text", text: "Error: No itemId provided and none found in session." }] };
        }

        const { itemId, itemType } = parseAquaItemId(rawItemId, input.itemType);
        
        const details = await aquaUtils.getItemDetails(aquaUrl, auth, itemId, itemType);
        const processedDetails = {
            title: details.Name,
            description: {
                html: details.Description?.Html || '',
                plainText: details.Description?.PlainText || ''
            }
        };
        return { content: [{ type: "text", text: JSON.stringify(processedDetails, null, 2) }] };
    }));

    server.registerTool("aquacloud_add-comment-to-item", {
        title: "Add Comment to Aqua Cloud Item",
        description: "Adds a comment to the discussion history of an Aqua Cloud work item. Requires a mapping to be set in the session.",
        inputSchema: {
            itemId: z.string().optional().describe("The ID of the item, with or without its prefix (e.g., 'DF068415' or '68415'). Defaults to the task ID from the session."),
            comment: z.string().describe("The content of the comment to add. Supports HTML."),
            itemType: z.string().optional().describe("The type of the item (e.g., 'Requirement', 'Defect'). If omitted, the type will be inferred from the itemId prefix."),
        }
    }, (input) => withAuth(async (auth, aquaUrl) => {
        const rawItemId = input.itemId || sessionMemory.taskId; // Use session task ID as fallback
        if (!rawItemId) {
            return { content: [{ type: "text", text: "Error: No itemId provided and none found in session." }] };
        }

        const { itemId, itemType } = parseAquaItemId(rawItemId, input.itemType);
        const { comment } = input;

        await aquaUtils.addCommentToItem(aquaUrl, auth, itemId, comment, itemType);
        return { content: [{ type: "text", text: `Successfully added comment to item ${itemType} ${itemId}.` }] };
    }));

    server.registerTool("aquacloud_create-item", {
        title: "Create Item in Aqua Cloud",
        description: "Creates one or more items (e.g., a Requirement). If a parentItemId is provided, it creates sub-items. Otherwise, it creates top-level items in a project.",
        inputSchema: {
            parentItemId: z.string().optional().describe("The ID of the parent Requirement, with or without prefix (e.g., 'RQ0123'). If provided, creates sub-items."),
            itemType: z.string().default('Requirement').describe("The type of item to create. Defaults to 'Requirement'."),
            tasks: z.array(z.object({
                title: z.string().describe("The title of the item."),
                description: z.string().describe("The description of the item."),
            })).describe("An array of item objects to create."),
        }
    }, (input) => withAuth(async (auth, aquaUrl) => {
        const rawParentId = input.parentItemId;
        const projectId = sessionMemory.aquaProjectId;
        let numericParentId = null;

        if (!projectId) {
            return { content: [{ type: "text", text: "Error: No projectId found in the session." }] };
        }

        if (rawParentId && rawParentId !== "%TASK_CONTEXT_TASK_ID%") {
            // A parent is assumed to be a Requirement, but parseAquaItemId will handle any prefix
            // We pass 'Requirement' as the default type if no prefix is found.
            const { itemId: parsedId } = parseAquaItemId(rawParentId, 'Requirement');
            numericParentId = parsedId;
        }

        const createdItems = [];
        for (const task of input.tasks) {
            const result = await aquaUtils.createItem(aquaUrl, auth, task, {
                parentRequirementId: numericParentId, // This is now the parsed numeric ID
                projectId: projectId,
                itemType: input.itemType
            });
            createdItems.push(result);
        }
        return { content: [{ type: "text", text: `Successfully created ${createdItems.length} item(s). Response: ${JSON.stringify(createdItems, null, 2)}` }] };
    }));

    server.registerTool("aquacloud_get-test-steps", {
        title: "Get Test Steps for a TestCase",
        description: "Fetches the detailed test steps for a given TestCase item.",
        inputSchema: {
            testCaseId: z.string().optional().describe("The ID of the TestCase item, with or without prefix (e.g., 'TC0123' or '123'). Defaults to task ID from session."),
        }
    }, (input) => withAuth(async (auth, aquaUrl) => {
        const rawItemId = input.testCaseId || sessionMemory.taskId;
        if (!rawItemId) {
            return { content: [{ type: "text", text: "Error: No testCaseId provided and none found in session." }] };
        }
        
        // For this tool, we force the type to 'TestCase'
        const { itemId, itemType } = parseAquaItemId(rawItemId, 'TestCase');

        if (itemType.toLowerCase() !== 'testcase') {
             return { content: [{ type: "text", text: `Error: The provided ID "${rawItemId}" does not appear to be a TestCase.` }] };
        }

        const steps = await aquaUtils.getTestSteps(aquaUrl, auth, itemId);
        return { content: [{ type: "text", text: JSON.stringify(steps, null, 2) }] };
    }));

    server.registerTool("aquacloud_add-test-steps", {
        title: "Add Test Steps to a TestCase",
        description: "Adds one or more test steps to an existing Aqua Cloud TestCase item. This requires locking the item.",
        inputSchema: {
            itemId: z.string().optional().describe("The ID of the TestCase, with or without prefix (e.g., 'TC0123' or '123'). Defaults to the task ID from the session."),
            itemType: z.string().optional().default('TestCase').describe("The type of the item. Must be 'TestCase' or a type that supports test steps."),
            steps: z.array(z.object({
                name: z.string().describe("The name or title of the test step."),
                instructions: z.string().describe("The detailed instructions or actions for the test step (as HTML text)."),
                expectedResult: z.string().describe("The expected result for the test step (as HTML text)."),
            })).describe("An array of test step objects to add."),
        }
    }, (input) => withAuth(async (auth, aquaUrl) => {
        const rawItemId = input.itemId || sessionMemory.taskId;
        if (!rawItemId) {
            return { content: [{ type: "text", text: "Error: No itemId provided and none found in session." }] };
        }

        // Default to 'TestCase' if not provided
        const { itemId, itemType } = parseAquaItemId(rawItemId, input.itemType || 'TestCase');

        if (itemType.toLowerCase() !== 'testcase') {
             return { content: [{ type: "text", text: `Error: The provided ID "${rawItemId}" does not appear to be a TestCase.` }] };
        }

        const existingSteps = await aquaUtils.getTestSteps(aquaUrl, auth, itemId);
        const currentStepCount = Array.isArray(existingSteps) ? existingSteps.length : 0;

        const updatePayload = {
            TestSteps: {
                Added: input.steps.map((step, index) => ({
                    Name: step.name,
                    Description: { Html: step.instructions },
                    ExpectedResult: { Html: step.expectedResult },
                    Automation: null,
                    Index: currentStepCount + index + 1,
                    StepType: 'Step',
                    uniqueId: randomUUID(),
                })),
            }
        };

        const result = await aquaUtils.updateLockedItem(aquaUrl, auth, itemId, itemType, updatePayload);
        return { content: [{ type: "text", text: `Successfully added ${input.steps.length} test step(s) to item ${itemId}. Response: ${JSON.stringify(result, null, 2)}` }] };
    }));


    return server;
}

// Handle POST requests for client-to-server communication.
app.post('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    let transport;

    if (sessionId && sessionTransports[sessionId]) {
        transport = sessionTransports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {

        // --- MODIFICATION START ---
        // Read credentials from headers instead of handshakeParams
        console.log("[Aqua-MCP-Standalone] Received initialize request. Checking headers...");
        const {
            'x-aqua-username': username,
            'x-aqua-password': password,
            'x-aqua-url': aquacloud_url,
            'x-aqua-projectid': projectId,
            'x-task-id': taskId // Capture the task ID from headers
        } = req.headers;

        if (!username || !password || !aquacloud_url || !projectId) {
            console.warn("[Aqua-MCP-Standalone] Initialize request failed: Missing required headers.");
            return res.status(401).json({
                error: { message: 'Unauthorized: Missing x-aqua-username, x-aqua-password, x-aqua-url, or x-aqua-projectid headers in initialize request.' }
            });
        }
        // --- MODIFICATION END ---

        try {
            console.log(`[Aqua-MCP-Standalone] Credentials provided for user: ${username}`);
            console.log(`[Aqua-MCP-Standalone] Context Task ID: ${taskId || 'N/A'}`); // Log the task ID

            const newSessionId = randomUUID();

            // Create a user-like object in memory for the session.
            const user = {
                aquacloud_username: username,
                aquacloud_password: password, // plain text
                aquacloud_url: aquacloud_url,
            };

            sessionMemoryStore[newSessionId] = {
                user,
                aquaProjectId: projectId, // Use project ID from header
                taskId: taskId || null, // Store the task ID in session memory
            };
            console.log(`[Aqua-MCP-Standalone] New session initialized: ${newSessionId}`);

            const server = createMcpServer(sessionMemoryStore[newSessionId]);

            transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => newSessionId,
                onsessioninitialized: (id) => { sessionTransports[id] = transport; },
            });

            transport.onclose = () => {
                if (transport.sessionId) {
                    console.log(`[Aqua-MCP-Standalone] Session closed: ${transport.sessionId}`);
                    delete sessionTransports[transport.sessionId];
                    delete sessionMemoryStore[transport.sessionId];
                    server.close();
                }
            };

            await server.connect(transport);
        } catch (error) {
            console.error('[Aqua-MCP-Standalone] Initialization error:', error);
            return res.status(500).json({ error: { message: 'Server error during initialization.' } });
        }
    } else {
        return res.status(400).json({ error: { message: 'Bad Request: A valid mcp-session-id header is required for non-initialize requests.' } });
    }

    // --- Add Task ID to session on subsequent requests ---
    // This ensures that even if the task ID changes, we capture it.
    if (transport && transport.sessionId && req.headers['x-task-id']) {
        const currentSessionId = transport.sessionId;
        if (sessionMemoryStore[currentSessionId] && sessionMemoryStore[currentSessionId].taskId !== req.headers['x-task-id']) {
             console.log(`[Aqua-MCP-Standalone] Updating Task ID for session ${currentSessionId}: ${req.headers['x-task-id']}`);
             sessionMemoryStore[currentSessionId].taskId = req.headers['x-task-id'];
        }
    }
    // --- End modification ---

    await transport.handleRequest(req, res, req.body);
});

const handleSessionRequest = async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    if (!sessionId || !sessionTransports[sessionId]) {
        return res.status(400).send('Invalid or missing mcp-session-id header');
    }

    // --- Add Task ID to session on subsequent requests ---
    if (req.headers['x-task-id']) {
         if (sessionMemoryStore[sessionId] && sessionMemoryStore[sessionId].taskId !== req.headers['x-task-id']) {
             console.log(`[Aqua-MCP-Standalone] Updating Task ID for session ${sessionId}: ${req.headers['x-task-id']}`);
             sessionMemoryStore[sessionId].taskId = req.headers['x-task-id'];
        }
    }
    // --- End modification ---

    const transport = sessionTransports[sessionId];
    await transport.handleRequest(req, res);
};

app.get('/mcp', handleSessionRequest);
app.delete('/mcp', handleSessionRequest);

const server = app.listen(PORT, () => {
    console.log(`🚀 Aqua Cloud MCP Standalone Server running on http://localhost:${PORT}/mcp`);
});

server.timeout = 600000; // 10 minutes
