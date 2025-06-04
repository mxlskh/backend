import dotenv from 'dotenv';

dotenv.config();

const config = {
  development: {
    apiUrl: 'http://localhost:3001',
    ttsEndpoint: 'http://localhost:3001/api/tts'
  },
  production: {
    apiUrl: process.env.RAILWAY_URL,
    ttsEndpoint: process.env.RAILWAY_URL ? `${process.env.RAILWAY_URL}/api/tts` : 'http://localhost:3001/api/tts'
  }
};

const env = process.env.NODE_ENV || 'development';
export default config[env]; 