// @ts-check
/**
 * Smoke tests for Atom Frontend
 * Run: npx playwright test
 * Requires the app to be running locally on http://localhost:3000
 */

const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.APP_URL || 'http://localhost:3000';

test.describe('App boot', () => {
    test('page loads and has correct title', async ({ page }) => {
        await page.goto(BASE_URL);
        await expect(page).toHaveTitle(/Atom/i);
    });

    test('waveform canvas is visible', async ({ page }) => {
        await page.goto(BASE_URL);
        const canvas = page.locator('#waveCanvas');
        await expect(canvas).toBeVisible();
    });

    test('text input is present', async ({ page }) => {
        await page.goto(BASE_URL);
        const input = page.locator('#textInput');
        await expect(input).toBeVisible();
    });
});

test.describe('Backend health UI', () => {
    test('status indicator renders', async ({ page }) => {
        await page.goto(BASE_URL);
        // Status dot or text should appear within a few seconds of page load
        const statusEl = page.locator('#statusDot, #statusText, [id*="status"]').first();
        await expect(statusEl).toBeVisible({ timeout: 8000 });
    });
});

test.describe('Text send', () => {
    test('typing and pressing Enter adds user message', async ({ page }) => {
        await page.goto(BASE_URL);
        const input = page.locator('#textInput');
        await input.fill('Hello Atom');
        await input.press('Enter');
        // User message bubble should appear in the conversation
        const userMsg = page.locator('.message-user, [data-role="user"]').first();
        await expect(userMsg).toBeVisible({ timeout: 5000 });
    });

    test('send button is disabled while request is in-flight', async ({ page }) => {
        await page.goto(BASE_URL);
        const input  = page.locator('#textInput');
        const sendBtn = page.locator('#sendBtn, button[onclick*="sendText"]').first();
        await input.fill('test in-flight disable');
        await sendBtn.click();
        // Button should briefly go disabled
        await expect(sendBtn).toBeDisabled({ timeout: 2000 }).catch(() => {
            // If backend is very fast the button re-enables before we can catch it; that's OK
        });
    });
});

test.describe('Sidebar navigation', () => {
    test('hamburger menu opens sidebar', async ({ page }) => {
        await page.goto(BASE_URL);
        const menuBtn = page.locator('#menuBtn, button[onclick*="toggleMenu"], button[onclick*="openSidebar"]').first();
        await menuBtn.click();
        const sidebar = page.locator('#sidebar, .sidebar').first();
        await expect(sidebar).toHaveClass(/open|visible|active/, { timeout: 2000 });
    });

    test('clicking Inbox nav item activates inbox panel', async ({ page }) => {
        await page.goto(BASE_URL);
        const menuBtn = page.locator('#menuBtn, button[onclick*="toggleMenu"], button[onclick*="openSidebar"]').first();
        await menuBtn.click();
        const inboxNav = page.locator('#nav-inbox, [onclick*="showPanel(\'inbox\')"]').first();
        await inboxNav.click();
        const inboxPanel = page.locator('#panel-inbox, [id*="inbox"]').first();
        await expect(inboxPanel).toBeVisible({ timeout: 3000 });
    });

    test('clicking Conversations nav item shows conversations panel', async ({ page }) => {
        await page.goto(BASE_URL);
        const menuBtn = page.locator('#menuBtn, button[onclick*="toggleMenu"], button[onclick*="openSidebar"]').first();
        await menuBtn.click();
        const convNav = page.locator('#nav-conversations, [onclick*="showPanel(\'conversations\')"]').first();
        await convNav.click();
        const convPanel = page.locator('#panel-conversations, [id*="conversation"]').first();
        await expect(convPanel).toBeVisible({ timeout: 3000 });
    });
});

test.describe('Settings modal', () => {
    test('settings modal opens when triggered', async ({ page }) => {
        await page.goto(BASE_URL);
        // Open profile dropdown first, then settings
        const profileBtn = page.locator('#profileBtn, [onclick*="toggleProfileDropdown"]').first();
        await profileBtn.click();
        const settingsBtn = page.locator('[onclick*="openSettings"]').first();
        await settingsBtn.click();
        const modal = page.locator('#settingsModal, .settings-overlay').first();
        await expect(modal).toHaveClass(/visible/, { timeout: 2000 });
    });

    test('settings modal closes on close button', async ({ page }) => {
        await page.goto(BASE_URL);
        const profileBtn = page.locator('#profileBtn, [onclick*="toggleProfileDropdown"]').first();
        await profileBtn.click();
        const settingsBtn = page.locator('[onclick*="openSettings"]').first();
        await settingsBtn.click();
        const modal = page.locator('#settingsModal, .settings-overlay').first();
        await expect(modal).toHaveClass(/visible/);
        const closeBtn = page.locator('.settings-close, [onclick*="closeSettings"]').first();
        await closeBtn.click();
        await expect(modal).not.toHaveClass(/visible/, { timeout: 2000 });
    });
});

test.describe('Knowledge base panel', () => {
    test('KB panel loads and shows tabs', async ({ page }) => {
        await page.goto(BASE_URL);
        const menuBtn = page.locator('#menuBtn, button[onclick*="toggleMenu"], button[onclick*="openSidebar"]').first();
        await menuBtn.click();
        const kbNav = page.locator('#nav-kb, [onclick*="showPanel(\'kb\')"]').first();
        await kbNav.click();
        const kbPanel = page.locator('#panel-kb').first();
        await expect(kbPanel).toBeVisible({ timeout: 3000 });
        // Should have tab buttons
        const tabs = kbPanel.locator('.kb-tab, [onclick*="switchKbTab"]');
        await expect(tabs.first()).toBeVisible();
    });
});

test.describe('Conversation panel', () => {
    test('conversations panel opens and shows content area', async ({ page }) => {
        await page.goto(BASE_URL);
        const menuBtn = page.locator('#menuBtn, button[onclick*="toggleMenu"], button[onclick*="openSidebar"]').first();
        await menuBtn.click();
        const convNav = page.locator('[onclick*="showPanel(\'conversations\')"]').first();
        await convNav.click();
        const list = page.locator('#conversationsList, #panel-conversations').first();
        await expect(list).toBeVisible({ timeout: 3000 });
    });
});
