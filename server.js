const express = require('express');
const bodyParser = require('body-parser');
const { Client } = require('pg');
const bridge = require("@vkontakte/vk-bridge");
const axios = require('axios');
const fs = require('fs');
const https = require('https');
const path = require('path');
const crypto = require('crypto');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;
const md5 = require('md5');
const clientSecret = '';

const client = new Client({
    user: '',
    host: '',
    database: '',
    password: '',
    port: 5432,
});

client.connect();
app.use(bodyParser.json());
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'X-Signature', 'X-Launch-Params']
}));


app.options('/save-test-result', cors());

const generateSignature = (params) => {
    const { user_id, test_id, score} = params;
    const paramsString = `user_id=${user_id}&test_id=${test_id}&score=${score}${clientSecret}`;
    return md5(paramsString);
};

const verifyLaunchParams = (params, receivedSignature) => {
    const expectedSignature = generateSignature(params);
    console.log("Expected Signature:", expectedSignature);
    console.log("Received Signature:", receivedSignature);
    return expectedSignature === receivedSignature;
};
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    next();
});

const logErrorToFile = (error) => {
    const filePath = path.join(__dirname, 'error.log');
    const timestamp = new Date().toISOString();
    const logMessage = `${timestamp} - ${error.stack}\n`;

    fs.appendFileSync(filePath, logMessage);
};

app.use((err, req, res, next) => {
    logErrorToFile(err);
    res.status(500).json({ error: 'Internal server error' });
});

app.get('/api/user-tests-count', async (req, res) => {
    try {
        const userId = req.query.user_id;
        const userTestsCountResponse = await axios.get(`https://localhost:3000/tests?user_id=${userId}`, {
            httpsAgent: new https.Agent({ rejectUnauthorized: false })
        });

        const testsCountData = userTestsCountResponse.data.length || 0;
        res.json({ tests_count: testsCountData });
    } catch (error) {
        console.error('Error fetching user tests count:', error);
        logErrorToFile(error);
        res.status(500).json({ error: 'An error occurred while fetching user tests count' });
    }
});
app.get('/tests', async (req, res) => {
    try {
        console.log('Received a GET request to fetch tests with user results');
        const userId = req.query.user_id;
        const userTestResultsQuery = 'SELECT test_id, score, timestamp FROM test_results WHERE user_id = $1';
        const userTestResultsValues = [userId];
        const userTestResultsResult = await client.query(userTestResultsQuery, userTestResultsValues);
        const userTestResults = userTestResultsResult.rows;
        const testsWithResults = userTestResults.map(result => ({
            id: result.test_id,
            score: result.score,
            time: result.timestamp,
        }));

        res.status(200).json(testsWithResults);
    } catch (error) {
        console.error('Error fetching tests with user results:', error);
        res.status(500).json({ error: 'An error occurred while fetching tests with user results' });
    }
});

app.get('/api/topusers', async (req, res) => {
    try {
        console.log('Received a GET request to fetch top users');

        const topUsersQuery = `
            SELECT
                user_id,
                NULL AS first_name,
                NULL AS last_name,
                NULL AS avatar,
                SUM(score) AS score
            FROM
                test_results
            GROUP BY
                user_id
            ORDER BY
                score DESC
            LIMIT
                10;
        `;

        const topUsersResult = await client.query(topUsersQuery);
        const topUsers = topUsersResult.rows;

        res.status(200).json(topUsers);
    } catch (error) {
        console.error('Error fetching top users:', error);
        res.status(500).json({ error: 'An error occurred while fetching top users data' });
    }
});

app.get('/leaderboard', async (req, res) => {
    try {
        console.log('Received a GET request to fetch leaderboard');
        const leaderboardQuery = `
            SELECT user_id, users.first_name, users.last_name, leaderboard.score
            FROM test_results
                     JOIN leaderboard ON user.id = leaderboard.user_id
            ORDER BY leaderboard.score DESC
            LIMIT 10
        `;
        const leaderboardResult = await client.query(leaderboardQuery);
        const leaderboard = leaderboardResult.rows;
        res.status(200).json(leaderboard);
    } catch (error) {
        console.error('Error fetching leaderboard:', error);
        res.status(500).json({ error: 'An error occurred while fetching leaderboard' });
    }
});

app.post('/save-test-result', async (req, res) => {
    try {
        console.log("Received data:", req.body);

        const {
            vk_access_token_settings, vk_app_id, vk_are_notifications_enabled,
            vk_is_app_user, vk_is_favorite, vk_language, vk_platform, vk_ref,
            vk_ts, vk_user_id, timestamp, nonce, score, test_id, user_id, totalQuestions
        } = req.body;

        const params = {
            vk_access_token_settings, vk_app_id, vk_are_notifications_enabled,
            vk_is_app_user, vk_is_favorite, vk_language, vk_platform, vk_ref,
            vk_ts, vk_user_id, timestamp, nonce, score, test_id, user_id, totalQuestions
        };

        const receivedSignature = req.headers['x-signature'];
        const signatureVerificationResult = await verifyLaunchParams(params, receivedSignature);
        if (!signatureVerificationResult) {
            res.status(400).json({ error: 'Invalid signature' });
            return;
        }
        if (user_id !== vk_user_id) {
            console.log('server: User ID does not match vk_user_id');
            return res.status(400).json({ error: 'User ID mismatch' });
        }
        if (typeof user_id !== 'number' || typeof test_id !== 'number' || typeof score !== 'number' || typeof totalQuestions !== 'number') {
            return res.status(400).json({ error: 'Invalid data format' });
        }
        if (score < 0 || score > totalQuestions) {
            return res.status(400).json({ error: 'Invalid score value' });
        }
        const resultQuery = `SELECT * FROM test_results WHERE user_id = $1 AND test_id = $2`;
        const resultValues = [user_id, test_id];
        const result = await client.query(resultQuery, resultValues);
        const existingResult = result.rows[0];

        if (existingResult) {
            const updateQuery = `UPDATE test_results SET score = $1, timestamp = NOW() WHERE user_id = $2 AND test_id = $3`;
            await client.query(updateQuery, [score, user_id, test_id]);
            console.log('server: Test result updated successfully');
        } else {
            const insertQuery = `INSERT INTO test_results (user_id, test_id, score, timestamp) VALUES ($1, $2, $3, NOW())`;
            await client.query(insertQuery, [user_id, test_id, score]);
            console.log('server: New test result saved successfully');
        }
        res.status(200).json({ success: true });
    } catch (error) {
        console.error('Error saving test result:', error);
        logErrorToFile(error);
        res.status(500).json({ error: 'An error occurred while saving test result' });
    }
});

const httpsOptions = {
    key: fs.readFileSync('key.key'),
    cert: fs.readFileSync('certificate.crt')
};

https.createServer(httpsOptions, app).listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
