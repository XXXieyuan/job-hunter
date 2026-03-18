'use strict';

class OpenAI {
  constructor(config = {}) {
    this.apiKey = config.apiKey || '';
    this.baseURL = (config.baseURL || 'https://api.openai.com/v1').replace(/\/$/, '');
    const headers = () => ({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`
    });

    this.embeddings = {
      create: async (payload) => {
        const response = await fetch(`${this.baseURL}/embeddings`, {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify(payload)
        });
        if (!response.ok) {
          throw new Error(`OpenAI embeddings request failed with status ${response.status}`);
        }
        return response.json();
      }
    };

    this.chat = {
      completions: {
        create: async (payload) => {
          const response = await fetch(`${this.baseURL}/chat/completions`, {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify(payload)
          });
          if (!response.ok) {
            throw new Error(`OpenAI chat request failed with status ${response.status}`);
          }
          return response.json();
        }
      }
    };
  }
}

module.exports = OpenAI;
module.exports.OpenAI = OpenAI;
