// src/api/voice.ts
export async function triggerWebhook() {
  try {
    const response = await fetch('https://your-backend-url/voice/trigger', {
      method: 'GET',
    });
    return await response.json();
  } catch (error) {
    console.error('Failed to trigger webhook:', error);
    throw error;
  }
}
