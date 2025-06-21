
import React, { useState } from 'react';

function VoiceRecorder() {
  const [transcription, setTranscription] = useState('');
  const [recording, setRecording] = useState(false);
  const [mediaRecorder, setMediaRecorder] = useState(null);
  const [audioChunks, setAudioChunks] = useState([]);

  const startRecording = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream);
    setMediaRecorder(recorder);
    const chunks = [];

    recorder.ondataavailable = event => chunks.push(event.data);
    recorder.onstop = () => {
      const audioBlob = new Blob(chunks, { type: 'audio/mp3' });
      const formData = new FormData();
      formData.append('file', audioBlob, 'voice.mp3');

      fetch('atom-backend-production-8a1e.up.railway.app/voice/voice-command', {
        method: 'POST',
        body: formData,
      })
        .then(res => res.json())
        .then(data => {
          const text = data?.result?.text || 'No transcription received.';
          setTranscription(text);
        })
        .catch(err => {
          console.error('Error:', err);
          setTranscription('Error receiving transcription.');
        });

      setAudioChunks([]);
    };

    recorder.start();
    setAudioChunks(chunks);
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
          <h3>🗣️ Transcription Result:</h3>
          <p>{transcription}</p>
        </div>
      )}
    </div>
  );
}

export default VoiceRecorder;
