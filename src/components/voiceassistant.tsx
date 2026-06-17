 import React from 'react';

export default function VoiceAssistant() {
  const startVoiceCapture = async () => {
    const media = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mediaRecorder = new MediaRecorder(media);
    const audioChunks: Blob[] = [];

    mediaRecorder.ondataavailable = event => audioChunks.push(event.data);

    mediaRecorder.onstop = async () => {
      const audioBlob = new Blob(audioChunks, { type: 'audio/mp3' });
      const formData = new FormData();
      formData.append('audio', audioBlob, 'recording.mp3');

      await fetch('https://your-backend.up.railway.app/voice/transcribe', {
        method: 'POST',
        body: formData,
      });
    };

    mediaRecorder.start();
    setTimeout(() => mediaRecorder.stop(), 5000); // 5 seconds
  };

  return (
    <div style={{
      backgroundColor: '#12100e',
      color: '#ff66cc',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center'
    }}>
      <div style={{ fontSize: '2rem', margin: '0.5rem' }}>▲</div>
      <h1>Assistant</h1>
      <button
        onClick={startVoiceCapture}
        style={{
          width: '300px',
          height: '150px',
          background: 'none',
          border: 'none',
          cursor: 'pointer'
        }}
      >
        <div style={{ width: '100%', height: '100px', background: 'linear-gradient(90deg, #ff66cc 0%, #66ccff 50%, #66ffcc 100%)',
          animation: 'pulse 1.5s infinite ease-in-out',
          clipPath: 'path("M0,50 C50,0 100,100 150,50 C200,0 250,100 300,50 C350,0 400,100 450,50 C500,0 550,100 600,50")'
        }}>
        </div>
      </button>
      <style>{`
        @keyframes pulse {
          0%, 100% { transform: scaleY(1); }
          50% { transform: scaleY(1.25); }
        }
      `}</style>
    </div>
  );
}

