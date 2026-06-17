// @ts-check
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
    testDir: './tests',
    timeout: 30_000,
    retries: 1,
    use: {
        baseURL: process.env.APP_URL || 'http://localhost:3000',
        headless: true,
        screenshot: 'only-on-failure',
        video: 'retain-on-failure',
    },
    projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    ],
    // Start the app server automatically during test runs
    webServer: {
        command: 'node server.js',
        url: 'http://localhost:3000',
        reuseExistingServer: !process.env.CI,
        timeout: 15_000,
    },
});
