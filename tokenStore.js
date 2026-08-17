const fs = require('fs');
const path = require('path');

const TOKENS_FILE = path.join(__dirname, 'tokens.json');

function loadTokens() {
  try {
    return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
  } catch (err) {
    return {};
  }
}

let tokens = loadTokens();

function get(userId) {
  return tokens[userId];
}

function set(userId, token) {
  tokens[userId] = token;
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
}

module.exports = { get, set };
