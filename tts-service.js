const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile, exec } = require('child_process');

const CACHE_DIR = path.join(__dirname, 'tts-cache');

// Ensure cache directory exists
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

class TTSService {
  constructor({ apiKey, voice = 'nova', a2dpSink = null }) {
    this.apiKey = apiKey;
    this.voice = voice;
    this.a2dpSink = a2dpSink;
    this.enabled = !!apiKey;

    if (!this.enabled) {
      console.log('⚠️  OPENAI_API_KEY not set — TTS disabled, text-only coaching active');
    } else {
      console.log(`🔊 TTS service initialized (voice: ${voice})`);
    }
  }

  /**
   * Generate or retrieve cached TTS audio for the given text.
   * Returns the filename (relative to tts-cache/) or null if TTS is disabled.
   */
  async speak(text) {
    if (!this.enabled || !text) return null;

    const hash = crypto.createHash('sha256').update(text).digest('hex');
    const filename = hash + '.mp3';
    const filepath = path.join(CACHE_DIR, filename);

    // Cache hit
    if (fs.existsSync(filepath)) {
      return filename;
    }

    // Cache miss — call OpenAI TTS API
    try {
      const response = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'tts-1',
          input: text,
          voice: this.voice,
          response_format: 'mp3'
        })
      });

      if (!response.ok) {
        const errBody = await response.text();
        console.error(`TTS API error (${response.status}):`, errBody);
        return null;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(filepath, buffer);
      console.log(`🔊 TTS cached: "${text.substring(0, 50)}..." → ${filename.substring(0, 12)}...`);
      return filename;
    } catch (error) {
      console.error('TTS API call failed:', error.message);
      return null;
    }
  }

  /**
   * Play audio file through A2DP speaker (RPi host).
   * Tries mpv (handles mp3 natively), falls back to paplay.
   */
  playOnSpeaker(filename) {
    if (!this.a2dpSink || !filename) return;

    const filepath = path.join(CACHE_DIR, filename);
    if (!fs.existsSync(filepath)) return;

    // ffmpeg decodes mp3 to wav and pipes to paplay for A2DP playback
    const cmd = `ffmpeg -y -i "${filepath}" -f wav - 2>/dev/null | paplay --device=${this.a2dpSink}`;
    exec(cmd, (err) => {
      if (err) console.error('A2DP playback failed:', err.message);
    });
  }
}

module.exports = TTSService;
