const { encrypt, decrypt } = require('../crypto.js');
const aquaApi = require('./aquaUtils.js');

/**
 * A wrapper for making authenticated calls to the AquaCloud API.
 * It handles token management (login, refresh) for API calls.
 * @param {object} req - The Express request object.
 * @param {object} res - The Express response object.
 * @param {function} apiCall - The function to call with an auth object. It will receive { token, type }.
 * @param {object} [options={}] - Options object.
 * @param {boolean} [options.silent=false] - If true, suppresses sending an error response on failure.
 * @returns {Promise<any|null>} - The result of the apiCall, or null on failure.
 */
async function withAquaAuth(req, res, apiCall, { silent = false } = {}) {
    const user = req.user;
    if (!user.aquacloud_url || !user.aquacloud_username) {
        console.error(`Aqua API call failed: Missing AquaCloud URL or Username for user ${user.email}.`);
        if (!silent) {
            res.status(401).json({ error: 'This action requires AquaCloud to be configured.' });
        }
        return null;
    }

    const aquaUrl = user.aquacloud_url;
    let accessToken = user.aquacloud_access_token ? decrypt(user.aquacloud_access_token) : null;

    // Helper to perform the actual API call
    const performApiCall = async (token) => {
        return await apiCall({ token: token, type: 'bearer' });
    };

    // If we have an access token, try to use it first.
    if (accessToken) {
        try {
            return await performApiCall(accessToken);
        } catch (err) {
            // If it's not a 401, it's an unrelated API error.
            if (!err.response || err.response.status !== 401) {
                const errorMessage = err.response ? JSON.stringify(err.response.data) : err.message;
                console.error('Aqua API call failed:', errorMessage);
                if (!silent) {
                    res.status(err.response ? err.response.status : 500).json({ error: `An error occurred with AquaCloud: ${err.message}` });
                }
                return null;
            }
            // If it IS a 401, the token is expired. Proceed to refresh.
            console.log('AquaCloud access token expired or invalid. Refreshing...');
        }
    }

    // --- Token Refresh or Initial Login Logic ---
    // 1. Attempt to refresh the token.
    const refreshTokenString = user.aquacloud_refresh_token ? decrypt(user.aquacloud_refresh_token) : null;
    if (refreshTokenString) {
        try {
            console.log('AquaCloud access token invalid. Attempting refresh with refresh token.');
            const newTokens = await aquaApi.refreshToken(aquaUrl, refreshTokenString);
            user.aquacloud_access_token = encrypt(newTokens.access_token);
            if (newTokens.refresh_token) {
                user.aquacloud_refresh_token = encrypt(newTokens.refresh_token);
            }
            await user.save();
            console.log('AquaCloud token refreshed successfully. Retrying API call.');
            return await performApiCall(newTokens.access_token);
        } catch (refreshErr) {
            console.error('AquaCloud refresh token failed, falling back to password login. Error:', refreshErr.response ? JSON.stringify(refreshErr.response.data) : refreshErr.message);
            // Don't return, just fall through to password login.
        }
    }

    // 2. If refresh fails or no refresh token, try to login with password.
    if (user.aquacloud_password) {
        try {
            console.log('Attempting login with username/password.');
            const password = decrypt(user.aquacloud_password);
            const newTokens = await aquaApi.login(aquaUrl, user.aquacloud_username, password);
            user.aquacloud_access_token = encrypt(newTokens.access_token);
            if (newTokens.refresh_token) {
                user.aquacloud_refresh_token = encrypt(newTokens.refresh_token);
            }
            await user.save();
            console.log('AquaCloud login successful. Retrying API call.');
            return await performApiCall(newTokens.access_token);
        } catch (loginErr) {
            console.error('Failed to acquire AquaCloud token via login:', loginErr.response ? JSON.stringify(loginErr.response.data) : loginErr.message);
            // If login fails, this is our last resort. Clean up and fail.
            user.aquacloud_access_token = undefined;
            user.aquacloud_refresh_token = undefined;
            await user.save();
            if (!silent) {
                res.status(401).json({ error: 'Failed to authenticate with AquaCloud. Please check your credentials.' });
            }
            return null;
        }
    }

    // 3. If no other options, fail.
    console.error(`Aqua API call failed: No valid refresh token or password available for user ${user.email}.`);
    if (!silent) {
        res.status(401).json({ error: 'AquaCloud authentication failed. Please re-configure your credentials.' });
    }
    return null;
}

module.exports = { withAquaAuth };