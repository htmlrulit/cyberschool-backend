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
const redis = require('redis');

const redisClient = redis.createClient({
    host: 'localhost',
    port: 6379
});

redisClient.on('error', (err) => console.log('Redis Client Error', err));
redisClient.connect();

const client = new Client({
    user: '',
    host: 'localhost',
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

const updateTopUsersCache = async () => {
    const cacheKey = 'topusers';
    try {
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

        await redisClient.setEx(cacheKey, 60, JSON.stringify(topUsers));  // Установка кэша на 60 секунд для надежности

        console.log("Top users cache updated successfully:", new Date());
    } catch (error) {
        console.error('Error updating top users cache:', error);
    }
};

setInterval(updateTopUsersCache, 15000);

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
    const cacheKey = 'topusers';

    try {
        console.log("Attempting to retrieve top users from cache...");
        const cachedTopUsers = await redisClient.get(cacheKey);

        if (cachedTopUsers) {
            console.log("Top users data retrieved from cache.");
            res.status(200).json(JSON.parse(cachedTopUsers));
        } else {
            console.log("No cached top users data available.");
            res.status(500).json({ error: 'Cache miss, please try again' });
        }
    } catch (error) {
        console.error('Error fetching top users from cache:', error);
        res.status(500).json({ error: 'An error occurred while fetching top users data' });
    }
});

app.get('/leaderboard', async (req, res) => {
    const cacheKey = 'leaderboard';

    try {
        console.log("Attempting to retrieve leaderboard from cache...");
        const cachedLeaderboard = await redisClient.get(cacheKey);

        if (cachedLeaderboard) {
            console.log("Leaderboard data retrieved from cache.");
            return res.status(200).json(JSON.parse(cachedLeaderboard));
        }

        console.log("No cached leaderboard found, querying database...");
        const leaderboardQuery = `
            SELECT user_id, users.first_name, users.last_name, leaderboard.score
            FROM test_results
                     JOIN leaderboard ON user.id = leaderboard.user_id
            ORDER BY leaderboard.score DESC
            LIMIT 10
        `;
        const leaderboardResult = await client.query(leaderboardQuery);
        const leaderboard = leaderboardResult.rows;

        console.log("Leaderboard data retrieved from database: ", leaderboard);

        console.log("Caching new leaderboard data...");
        await redisClient.setEx(cacheKey, 15, JSON.stringify(leaderboard));

        console.log("New leaderboard data cached.");
        res.status(200).json(leaderboard);
    } catch (error) {
        console.error('Error fetching leaderboard:', error);
        res.status(500).json({ error: 'An error occurred while fetching leaderboard' });
    }
});


app.post('/save-test-result', async (req, res) => {
    const { vk_user_id, score, test_id, user_id, totalQuestions } = req.body;
    const receivedSignature = req.headers['x-signature'];
    const lockKey = `lock:testResult:${user_id}:${test_id}`;

    try {
        const lockSet = await redisClient.set(lockKey, 'locked', 'NX', 'PX', 30000);
        if (!lockSet) {
            console.log('server: Operation is currently in progress for user:', user_id, 'test:', test_id);
            return res.status(429).json({ error: 'Operation is currently in progress.' });
        }

        if (!verifyLaunchParams(req.body, receivedSignature)) {
            console.log('server: Invalid signature detected.');
            return res.status(400).json({ error: 'Invalid signature' });
        }

        const now = new Date();
        const resultQuery = `SELECT timestamp FROM test_results WHERE user_id = $1 AND test_id = $2 ORDER BY timestamp DESC LIMIT 1`;
        const result = await client.query(resultQuery, [user_id, test_id]);
        const existingResult = result.rows[0];

        if (existingResult) {
            const lastTestTime = new Date(existingResult.timestamp);
            const timeDiff = (now - lastTestTime) / 1000;
            console.log(`Time difference since last test: ${timeDiff} seconds`);
            if (timeDiff < 15) {
                console.log(`Submission too soon. Time difference: ${timeDiff} seconds.`);
                return res.status(429).json({ error: 'Submission too soon. Please wait longer.' });
            }
        }

        const updateOrInsertQuery = existingResult ?
            `UPDATE test_results SET score = ${score}, timestamp = NOW() WHERE user_id = ${user_id} AND test_id = ${test_id}` :
            `INSERT INTO test_results (user_id, test_id, score, timestamp) VALUES (${user_id}, ${test_id}, ${score}, NOW())`;

        console.log(`Executing query: ${updateOrInsertQuery}`);

        await client.query(updateOrInsertQuery);
        console.log(`Test result for user ${user_id} on test ${test_id} saved or updated successfully.`);

        res.status(200).json({ success: true });
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'An error occurred while saving test result' });
    } finally {
        await redisClient.del(lockKey);
    }
});



const httpsOptions = {
    key: fs.readFileSync('key.key'),
    cert: fs.readFileSync('certificate.crt')
};

https.createServer(httpsOptions, app).listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
