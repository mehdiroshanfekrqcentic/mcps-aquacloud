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
    // Add your custom headers to the allowedHeaders list
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

    const withAuth = async (toolFn) => {
        try {
            const auth = await getAquaAuth(sessionMemory);
            const aquaUrl = sessionMemory.user.aquacloud_url;
            return await toolFn(auth, aquaUrl);
        } catch (error) {
            const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
            console.error(`[Aqua-MCP-Standalone] Tool execution error:`, error);
            return { content: [{ type: "text", text: `Error: ${errorMessage}` }] };
        }
    };
    
    server.registerTool("aquacloud_get-item-details", {
        title: "Get Aqua Cloud Item Details",
        description: "Fetches the full details of an Aqua Cloud work item (e.g., Requirement, Defect, TestCase).",
        inputSchema: {
            itemId: z.string().optional().describe("The ID of the item. Defaults to the task ID from the session."),
            itemType: z.string().describe("The type of the item (e.g., 'Requirement', 'Defect', 'TestCase')."),
        }
    }, (input) => withAuth(async (auth, aquaUrl) => {
        const itemId = input.itemId;
        if (!itemId) return { content: [{ type: "text", text: "Error: No itemId provided and none found in session." }] };
        const details = await aquaUtils.getItemDetails(aquaUrl, auth, itemId, input.itemType);
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
            itemId: z.string().optional().describe("The ID of the item. Defaults to the task ID from the session."),
            comment: z.string().describe("The content of the comment to add. Supports HTML."),
            itemType: z.string().describe("The type of the item (e.g., 'Requirement', 'Defect', 'TestCase')."),
        }
    }, (input) => withAuth(async (auth, aquaUrl) => {
        const { itemType, comment, itemId } = input;
        if (!itemId) return { content: [{ type: "text", text: "Error: No itemId provided and none found in session." }] };

        await aquaUtils.addCommentToItem(aquaUrl, auth, itemId, comment, itemType);
        return { content: [{ type: "text", text: `Successfully added comment to item ${itemId}.` }] };
    }));

    server.registerTool("aquacloud_create-item", {
        title: "Create Item in Aqua Cloud",
        description: "Creates one or more items (e.g., a Requirement). If a parentItemId is provided, it creates sub-items. Otherwise, it creates top-level items in a project.",
        inputSchema: {
            parentItemId: z.string().optional().describe("The ID of the parent Requirement. If provided, creates sub-items. Defaults to the task ID from the session if available."),
            itemType: z.string().default('Requirement').describe("The type of item to create. Defaults to 'Requirement'."),
            tasks: z.array(z.object({
                title: z.string().describe("The title of the item."),
                description: z.string().describe("The description of the item."),
            })).describe("An array of item objects to create."),
        }
    }, (input) => withAuth(async (auth, aquaUrl) => {
        const parentItemId = input.parentItemId;
        const projectId = sessionMemory.aquaProjectId;

        if (!projectId) {
            return { content: [{ type: "text", text: "Error: No projectId provided, and neither was found in the session." }] };
        }

        const createdItems = [];
        for (const task of input.tasks) {
            // The createItem function correctly handles parentRequirementId being null.
            const result = await aquaUtils.createItem(aquaUrl, auth, task, {
                parentRequirementId: parentItemId && parentItemId != "%TASK_CONTEXT_TASK_ID%" ? parentItemId : null,
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
            testCaseId: z.string().optional().describe("The ID of the TestCase item. Defaults to task ID from session."),
        }
    }, (input) => withAuth(async (auth, aquaUrl) => {
        const testCaseId = input.testCaseId;
        if (!testCaseId) return { content: [{ type: "text", text: "Error: No testCaseId provided and none found in session." }] };
        const steps = await aquaUtils.getTestSteps(aquaUrl, auth, testCaseId);
        return { content: [{ type: "text", text: JSON.stringify(steps, null, 2) }] };
    }));

    server.registerTool("aquacloud_add-test-steps", {
        title: "Add Test Steps to a TestCase",
        description: "Adds one or more test steps to an existing Aqua Cloud TestCase item. This requires locking the item.",
        inputSchema: {
            itemId: z.string().optional().describe("The ID of the TestCase. Defaults to the task ID from the session."),
            itemType: z.string().optional().default('TestCase').describe("The type of the item. Must be a type that supports test steps, like 'TestCase'."),
            steps: z.array(z.object({
                name: z.string().describe("The name or title of the test step."),
                description: z.string().describe("The detailed description or action for the test step."),
            })).describe("An array of test step objects to add."),
        }
    }, (input) => withAuth(async (auth, aquaUrl) => {
        const itemId = input.itemId;
        if (!itemId) return { content: [{ type: "text", text: "Error: No itemId provided and none found in session." }] };

        const existingSteps = await aquaUtils.getTestSteps(aquaUrl, auth, itemId);
        const currentStepCount = Array.isArray(existingSteps) ? existingSteps.length : 0;

        const updatePayload = {
            TestSteps: {
                Added: input.steps.map((step, index) => ({
                    Name: step.name,
                    Description: { Html: step.description },
                    ExpectedResult: { Html: "" },
                    Automation: null,
                    Index: currentStepCount + index + 1,
                    StepType: 'Step',
                    uniqueId: randomUUID(),
                })),
            }
        };

        const result = await aquaUtils.updateLockedItem(aquaUrl, auth, itemId, input.itemType, updatePayload);
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
            'x-aqua-projectid': projectId
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

    await transport.handleRequest(req, res, req.body);
});

const handleSessionRequest = async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    if (!sessionId || !sessionTransports[sessionId]) {
        return res.status(400).send('Invalid or missing mcp-session-id header');
    }
    const transport = sessionTransports[sessionId];
    await transport.handleRequest(req, res);
};

app.get('/mcp', handleSessionRequest);
app.delete('/mcp', handleSessionRequest);

const server = app.listen(PORT, () => {
    console.log(`🚀 Aqua Cloud MCP Standalone Server running on http://localhost:${PORT}/mcp`);
});

server.timeout = 600000; // 10 minutes
