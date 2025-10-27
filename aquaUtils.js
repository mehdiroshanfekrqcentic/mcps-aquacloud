const axios = require('axios');
const { URLSearchParams } = require('url');
require('dotenv').config();
const FormData = require('form-data');

/**
 * A helper function to make API calls to AquaCloud using axios.
 * @param {string} url - The full URL for the API endpoint.
 * @param {string} method - The HTTP method.
 * @param {object} auth - The authentication object.
 * @param {string} auth.token - The OAuth access token.
 * @param {string} auth.type - The token type ('bearer').
 * @param {object|URLSearchParams} body - The request body for POST/PATCH/PUT requests.
 * @param {object} [headers={}] - Additional headers to include.
 * @param {string} [responseType=null] - The response type for axios (e.g., 'arraybuffer').
 * @returns {Promise<object>} - The JSON response from the API.
 */
async function callApi(url, method, auth, body = null, headers = {}, responseType = null) {
    const options = {
        method: method,
        url: url,
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            ...headers
        },
        validateStatus: () => true, // Let's handle all statuses
    };

    if (body instanceof URLSearchParams) {
        options.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    if (responseType) {
        options.responseType = responseType;
    }

    if (auth && auth.type === 'bearer') {
        options.headers['Authorization'] = `Bearer ${auth.token}`;
    }

    if (body) {
        options.data = body;
    }

    try {
        const response = await axios(options);

        // Check for auth error conditions.
        if (response.status === 401) {
            const authError = new Error('Authentication error');
            authError.response = { status: 401, data: response.data, headers: response.headers };
            throw authError;
        }

        if (response.status < 200 || response.status >= 300) {
            let errorDataForLogging = response.data;
            if (options.responseType === 'arraybuffer' && response.data) {
                try {
                    errorDataForLogging = JSON.parse(Buffer.from(response.data).toString());
                } catch (e) {
                    errorDataForLogging = `[Non-JSON error response with binary request. Body length: ${response.data.byteLength || response.data.length}]`;
                }
            }
            console.error(`Error during Aqua API call to ${url}: Status ${response.status}`, JSON.stringify(errorDataForLogging, null, 2));
            const apiError = new Error(`Aqua API call failed with status ${response.status}`);
            apiError.response = { status: response.status, data: response.data, headers: response.headers };
            throw apiError;
        }

        return response.data;
    } catch (error) {
        if (!error.response) {
            console.error(`Error during Aqua API call to ${url}:`, error.message);
        }
        throw error;
    }
}

/**
 * Logs into AquaCloud to get initial tokens.
 * @param {string} aquaUrl - The base URL of the AquaCloud instance.
 * @param {string} username - The user's username.
 * @param {string} password - The user's password.
 * @returns {Promise<object>} - The token response from the API.
 */
async function login(aquaUrl, username, password) {
    console.log(`Logging into AquaCloud for user ${username}...`);
    const tokenUrl = `${aquaUrl}/api/token`;
    const params = new URLSearchParams();
    params.append('grant_type', 'password');
    params.append('username', username);
    params.append('password', password);

    // No auth object needed for login
    return await callApi(tokenUrl, 'POST', null, params);
}

/**
 * Refreshes an expired AquaCloud access token.
 * @param {string} aquaUrl - The base URL of the AquaCloud instance.
 * @param {string} refreshToken - The refresh token.
 * @returns {Promise<object>} - The new token response from the API.
 */
async function refreshToken(aquaUrl, refreshToken) {
    console.log('Refreshing AquaCloud access token...');
    const tokenUrl = `${aquaUrl}/api/token`;
    const params = new URLSearchParams();
    params.append('grant_type', 'refresh_token');
    params.append('refresh_token', refreshToken);

    // No auth object needed for token refresh
    return await callApi(tokenUrl, 'POST', null, params);
}

// --- Placeholder Functions ---

/**
 * Gets a list of projects from AquaCloud.
 * (Placeholder - API endpoint for this is not specified in the docs)
 * @param {string} aquaUrl 
 * @param {object} auth 
 */
async function getProjects(aquaUrl, auth) {
    console.log("Fetching AquaCloud projects...");
    // This is a placeholder. In a real scenario, you'd find the endpoint to list projects.
    // For now, returning mock data based on the example.
    return [{ id: 240, name: 'Notar Cloud Integration' }, { id: 242, name: 'Actanda' }];
}

/**
 * Gets a list of statuses for a project from AquaCloud.
 * @param {string} aquaUrl 
 * @param {object} auth 
 * @param {number} projectId
 * @param {string} itemType - e.g., 'Requirement' or 'Defect'
 */
async function getStatusesForProject(aquaUrl, auth, projectId, itemType) {
    console.log(`Fetching statuses for AquaCloud project ${projectId}, item type ${itemType}...`);
    const url = `${aquaUrl}/api/Project/${projectId}/Meta/${itemType}/Fields/Status`;
    try {
        const response = await callApi(url, 'GET', auth);
        // The response is { Entries: [...] }. We map it to { id, name }.
        return response.Entries ? response.Entries.map(entry => ({ id: entry.Id, name: entry.Name })) : [];
    } catch (error) {
        console.error(`Failed to fetch statuses for project ${projectId} and item type ${itemType}:`, error);
        return [];
    }
}

/**
 * Gets a list of requirements (tasks) for an agent.
 * @param {string} aquaUrl 
 * @param {object} auth 
 * @param {number} projectId 
 * @param {string} agentName - The name of the agent as it appears in AquaCloud (e.g., "Agent, Notar Cloud (ncagent)").
 * @param {string} [itemType='Requirement'] - The type of item to fetch.
 */
async function getRequirements(aquaUrl, auth, projectId, agentName, triggerState = 'To Do', itemType = 'Requirement') {
    console.log(`Fetching ${itemType}s for agent '${agentName}' in project ${projectId} with status '${triggerState}'...`);
    const url = `${aquaUrl}/api/Navigation/ItemList?itemType=${itemType}&projectId=${projectId}&folderId=0&includeSubfolders=true&includeArchived=false&maxResults=50`;
    const body = {
        "Filter": `[["AssignedTo","=","${agentName}"],"and",["Status","=","${triggerState}"]]`,
        "Sorting": `[["LastModifiedDateTime","desc"]]`,
        "Search": null,
        "TimeZoneOffset": 240 // This might need to be dynamic later
    };
    const response = await callApi(url, 'POST', auth, body);
    return response.Items || [];
}

/**
 * Gets details for a single item.
 * @param {string} aquaUrl 
 * @param {object} auth 
 * @param {number} itemId 
 * @param {string} [itemType='Requirement'] - The type of item to fetch.
 */
async function getItemDetails(aquaUrl, auth, itemId, itemType = 'Requirement') {
    console.log(`Fetching details for AquaCloud ${itemType} ${itemId}...`);
    let url = `${aquaUrl}/api/${itemType}/${itemId}`;
    if (itemType === 'Defect') {
        url += '?withEnclosure=true';
    }
    return await callApi(url, 'GET', auth);
}

/**
 * Updates the status of an item.
 * @param {string} aquaUrl 
 * @param {object} auth 
 * @param {number} itemId 
 * @param {number} newStatusId 
 * @param {string} [itemType='Requirement'] - The type of item to update.
 */
async function updateItemStatus(aquaUrl, auth, itemId, newStatusId, itemType = 'Requirement') {
    console.log(`Updating status for AquaCloud ${itemType} ${itemId} to status ID '${newStatusId}'...`);
    const url = `${aquaUrl}/api/${itemType}/${itemId}`;
    // Using JSON Patch format, which is common for such APIs.
    const body = {
        "Details": [
            {
                "FieldId": "Status",
                "Value": parseInt(newStatusId, 10)
            }
        ]
    };
    return await callApi(url, 'PUT', auth, body);
}

/**
 * Adds a comment to an item using the /Post endpoint.
 * @param {string} aquaUrl
 * @param {object} auth
 * @param {number} itemId
 * @param {string} comment
 * @param {string} [itemType='Requirement'] - The type of item to comment on.
 */
async function addCommentToItem(aquaUrl, auth, itemId, comment, itemType = 'Requirement') {
    console.log(`Adding comment to AquaCloud ${itemType} ${itemId}...`);
    const url = `${aquaUrl}/api/${itemType}/${itemId}/Post`;
    const body = {
        Html: comment
    };
    return await callApi(url, 'POST', auth, body);
}

/**
 * Creates a new item in Aqua. It can be a sub-item if a parent is provided, or a top-level item if a project is provided.
 * @param {string} aquaUrl
 * @param {object} auth
 * @param {object} task
 * @param {string} task.title
 * @param {string} task.description
 * @param {object} options
 * @param {number} [options.parentRequirementId] - The ID of the parent requirement.
 * @param {number} [options.projectId] - The ID of the project (for top-level items).
 * @param {string} [options.itemType='Requirement'] - The type of the item to create.
 * @returns {Promise<object>}
 */
async function createItem(aquaUrl, auth, task, { parentRequirementId, projectId, itemType = 'Requirement' }) {
    let ProjectId, FolderId;

    if (parentRequirementId) {
        console.log(`Creating AquaCloud ${itemType} as sub-item for parent ${parentRequirementId}`);
        const parentDetails = await getItemDetails(aquaUrl, auth, parentRequirementId, 'Requirement');
        if (!parentDetails || !parentDetails.Location) {
            throw new Error(`Could not retrieve details for parent requirement ${parentRequirementId}`);
        }
        ProjectId = parentDetails.Location.ProjectId;
        FolderId = parentDetails.Location.FolderId;
    } else if (projectId) {
        console.log(`Creating AquaCloud ${itemType} as top-level item in project ${projectId}`);
        ProjectId = projectId;
        FolderId = 0; // Root folder
    } else {
        throw new Error('Either parentRequirementId or projectId must be provided to create an item.');
    }

    // Step 1: Create the new item
    const createUrl = `${aquaUrl}/api/${itemType}`;
    const createBody = {
        Location: { ProjectId, FolderId },
        Details: [
            { FieldId: 'Name', Value: task.title },
        ],
        Description: {
            Html: task.description,
        },
    };
    const newItem = await callApi(createUrl, 'POST', auth, createBody);
    if (!newItem || !newItem.Id) {
        throw new Error('Failed to create new item or item ID is missing.');
    }

    // Step 2: Link it as a sub-requirement (only applicable if parent is present and new item is a Requirement)
    if (parentRequirementId && itemType === 'Requirement') {
        console.log(`Linking requirement ${newItem.Id} as sub-requirement to ${parentRequirementId}`);
        const linkUrl = `${aquaUrl}/api/Requirement/${parentRequirementId}/Subrequirement`;
        const linkBody = { "id": newItem.Id };
        await callApi(linkUrl, 'POST', auth, linkBody);
    }

    return newItem;
}

/**
 * Gets the hierarchy tree for an item.
 * @param {string} aquaUrl
 * @param {object} auth
 * @param {number} itemId
 * @param {string} [itemType='Requirement']
 */
async function getItemHierarchy(aquaUrl, auth, itemId, itemType = 'Requirement') {
    console.log(`Fetching hierarchy for AquaCloud ${itemType} ${itemId}...`);
    const url = `${aquaUrl}/api/${itemType}/${itemId}/SubrequirementTree`; // Endpoint name is specific
    return await callApi(url, 'GET', auth);
}

/**
 * Gets attachments for a single item.
 * @param {string} aquaUrl
 * @param {object} auth
 * @param {number} itemId
 * @param {string} [itemType='Requirement']
 * @returns {Promise<Array>}
 */
async function getItemAttachments(aquaUrl, auth, itemId, itemType = 'Requirement') {
    console.log(`Fetching attachments for AquaCloud ${itemType} ${itemId}...`);
    const url = `${aquaUrl}/api/${itemType}/${itemId}/Attachment`;
    const attachments = await callApi(url, 'GET', auth);
    return attachments || [];
}

/**
 * Downloads a specific attachment.
 * @param {string} attachmentUrl
 * @param {object} auth
 * @returns {Promise<Buffer>}
 */
async function downloadAttachment(attachmentUrl, auth) {
    console.log(`Downloading attachment from ${attachmentUrl}...`);
    return await callApi(attachmentUrl, 'GET', auth, null, {}, 'arraybuffer');
}

/**
 * Uploads an attachment to an item.
 * @param {string} aquaUrl
 * @param {object} auth
 * @param {number} itemId
 * @param {Buffer} fileBuffer
 * @param {string} fileName
 * @param {string} [itemType='Requirement']
 * @returns {Promise<object>}
 */
async function uploadAttachmentToItem(aquaUrl, auth, itemId, fileBuffer, fileName, itemType = 'Requirement') {
    console.log(`Uploading attachment '${fileName}' to AquaCloud ${itemType} ${itemId}...`);
    const url = `${aquaUrl}/api/${itemType}/${itemId}/Attachment`;

    const form = new FormData();
    form.append('file', fileBuffer, fileName);

    const headers = form.getHeaders();

    return await callApi(url, 'POST', auth, form, headers);
}

/**
 * Gets test steps for a single TestCase.
 * @param {string} aquaUrl 
 * @param {object} auth 
 * @param {number} testCaseId 
 */
async function getTestSteps(aquaUrl, auth, testCaseId) {
    console.log(`Fetching test steps for AquaCloud TestCase ${testCaseId}...`);
    const url = `${aquaUrl}/api/TestCase/${testCaseId}/TestStep`;
    return await callApi(url, 'GET', auth);
}

/**
 * Locks an item for editing.
 * @param {string} aquaUrl
 * @param {object} auth
 * @param {number} itemId
 * @param {string} itemType
 * @param {number} version - The current version of the item.
 */
async function lockItem(aquaUrl, auth, itemId, itemType, version) {
    console.log(`Locking AquaCloud ${itemType} ${itemId} at version ${version}...`);
    const url = `${aquaUrl}/api/${itemType}/${itemId}/Lock`;
    const body = { "Version": version };
    return await callApi(url, 'POST', auth, body);
}

/**
 * Unlocks an item after editing.
 * @param {string} aquaUrl
 * @param {object} auth
 * @param {number} itemId
 * @param {string} itemType
 */
async function unlockItem(aquaUrl, auth, itemId, itemType) {
    console.log(`Unlocking AquaCloud ${itemType} ${itemId}...`);
    const url = `${aquaUrl}/api/${itemType}/${itemId}/Lock`;
    return await callApi(url, 'DELETE', auth);
}

/**
 * Updates an item that requires locking (e.g., TestCase). This function handles locking and unlocking.
 * @param {string} aquaUrl
 * @param {object} auth
 * @param {number} itemId
 * @param {string} itemType
 * @param {object} updatePayload - The payload containing modifications.
 */
async function updateLockedItem(aquaUrl, auth, itemId, itemType, updatePayload) {
    console.log(`Starting update process for AquaCloud ${itemType} ${itemId}...`);

    // Step 1: Get latest version
    const itemDetails = await getItemDetails(aquaUrl, auth, itemId, itemType);
    if (!itemDetails || !itemDetails.Version || typeof itemDetails.Version.Version === 'undefined') {
        throw new Error(`Could not retrieve version details for ${itemType} ${itemId}`);
    }
    const version = itemDetails.Version.Version;
    console.log(`...found version ${version}.`);

    // Step 2: Lock the test case
    await lockItem(aquaUrl, auth, itemId, itemType, version);
    console.log(`...locked ${itemType} ${itemId}.`);

    try {
        // Step 3: Update the test case
        console.log(`Updating AquaCloud ${itemType} ${itemId}...`);
        const url = `${aquaUrl}/api/${itemType}/${itemId}?explicitLock=true&applyDefaultValues=false`;
        const finalPayload = { ...updatePayload };
        // Special handling for TestCases
        if (itemType === 'TestCase' && finalPayload.TestSteps) {
            if (!finalPayload.TestSteps.Added) finalPayload.TestSteps.Added = [];
            if (!finalPayload.TestSteps.Deleted) finalPayload.TestSteps.Deleted = [];
        }
        return await callApi(url, 'PUT', auth, finalPayload);
    } finally {
        // Step 4: Unlock the test case
        await unlockItem(aquaUrl, auth, itemId, itemType);
        console.log(`...unlocked ${itemType} ${itemId}.`);
    }
}

module.exports = {
    callApi,
    login,
    refreshToken,
    getProjects,
    getStatusesForProject,
    getRequirements,
    getItemDetails,
    updateItemStatus,
    addCommentToItem,
    getItemAttachments,
    downloadAttachment,
    getItemHierarchy,
    createItem,
    uploadAttachmentToItem,
    getTestSteps,
    updateLockedItem,
};