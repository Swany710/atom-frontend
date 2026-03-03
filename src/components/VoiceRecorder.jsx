import React, { useState } from 'react';

// NOTE: The main app UI lives in public/index.html.
// This file is kept as a reference component but is not currently used.

function VoiceRecorder() {
    const [transcription, setTranscription] = useState('');
    const [recording, setRecording] = useState(false);
    const [mediaRecorder, setMediaRecorder] = useState(null);

    const startRecording = async () => {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const recorder = new MediaRecorder(stream);
        setMediaRecorder(recorder);
        const chunks = [];

        recorder.ondataavailable = event => chunks.push(event.data);
        recorder.onstop = async () => {
            const audioBlob = new Blob(chunks, { type: 'audio/mp3' });
            const formData = new FormData();
            formData.append('audio', audioBlob, 'audio.mp3');
            formData.append('userId', 'default-user');

            try {
                const apiBase = process.env.REACT_APP_API_BASE_URL || 'https://atom-backend-production-8a1e.up.railway.app/api/v1';
                const res = await fetch(`${apiBase}/ai/voice`, {
                    method: 'POST',
                    body: formData,
                });
                const data = await res.json();
                setTranscription(data?.transcription || data?.message || 'No response received.');
            } catch (err) {
                console.error('Error:', err);
                setTranscription('Error receiving response.');
            }
        };

        recorder.start();
        setRecording(true);
    };

    const stopRecording = () => {
        mediaRecorder.stop();
        setRecording(false);
    };

    return (
        <div className="voice-recorder">
            <button onClick={recording ? stopRecording : startRecording}>
                {recording ? 'Stop Recording' : 'Start Recording'}
            </button>

            {transcription && (
                <div className="transcription-output">
                    <h3>🗣️ Atom Response:</h3>
                    <p>{transcription}</p>
                </div>
            )}
        </div>
    );
}

export default VoiceRecorder;
