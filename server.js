/**
 * MCP Tools Server — Railway Deployment
 * Protocol: Model Context Protocol (MCP) over HTTP + SSE
 * Tools: web_fetch, web_search, memory_store, memory_get, file_read, file_write
 */

const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const path = require('path');

const app = express();
app.use(express.json({ limit: '10mb' }));

// ─── Database Setup (lowdb JSON) ─────────────────────────────────────────────
const DB_PATH = process.env.DB_PATH || '/tmp/mcp_data.json';
const adapter = new FileSync(DB_PATH);
const db = low(adapter);
db.defaults({ memories: {}, files: {} }).write();

// ─── MCP Tool Definitions ─────────────────────────────────────────────────────
const MCP_TOOLS = [
  {
    name: 'web_fetch',
    description: 'Fetch and extract clean text/markdown content from any URL. Useful for reading articles, documentation, or any web page.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The full URL to fetch (must start with http:// or https://)' },
        format: { type: 'string', enum: ['text', 'markdown', 'html'], description: 'Output format. Default: markdown' }
      },
      required: ['url']
    }
  },
  {
    name: 'web_search',
    description: 'Search the web using DuckDuckGo and return top results with titles, URLs, and snippets.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query' },
        max_results: { type: 'number', description: 'Maximum number of results to return (default: 5, max: 10)' }
      },
      required: ['query']
    }
  },
  {
    name: 'memory_store',
    description: 'Store a persistent memory/note that can be retrieved later across sessions. Use this to remember important information.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Unique key/name for this memory (e.g., "user_preferences", "project_notes")' },
        value: { type: 'string', description: 'The content to store' }
      },
      required: ['key', 'value']
    }
  },
  {
    name: 'memory_get',
    description: 'Retrieve a stored memory by key, or list all stored memories.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key to retrieve. Leave empty to list all stored memories.' },
        list_all: { type: 'boolean', description: 'Set to true to list all stored memory keys' }
      }
    }
  },
  {
    name: 'file_write',
    description: 'Write text content to a named file for persistent storage. Files are stored on the server and can be read back later.',
    inputSchema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'Name of the file (e.g., "notes.txt", "data.json")' },
        content: { type: 'string', description: 'Text content to write to the file' }
      },
      required: ['filename', 'content']
    }
  },
  {
    name: 'file_read',
    description: 'Read the content of a previously stored file. Use file_write first to store files.',
    inputSchema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'Name of the file to read' },
        list_files: { type: 'boolean', description: 'Set to true to list all available files' }
      }
    }
  }
];

// ─── Tool Implementations ─────────────────────────────────────────────────────

async function tool_web_fetch({ url, format = 'markdown' }) {
  if (!url) return err('URL is required');
  try { new URL(url); } catch { return err(`Invalid URL: ${url}`); }

  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MCPBot/1.0)' },
    timeout: 15000
  });

  if (!res.ok) return err(`HTTP ${res.status}: ${res.statusText} for ${url}`);

  const html = await res.text();
  const contentType = res.headers.get('content-type') || '';

  if (format === 'html') return ok(`[HTML from ${url}]\n\n${html.slice(0, 50000)}`);

  const $ = cheerio.load(html);

  // Remove noise
  $('script, style, nav, footer, header, iframe, noscript, [class*="ad"], [id*="ad"]').remove();

  const title = $('title').text().trim() || $('h1').first().text().trim();

  if (format === 'markdown') {
    let md = title ? `# ${title}\n\n` : '';
    md += `**Source:** ${url}\n\n`;

    // Extract main content
    const main = $('article, main, [role="main"], .content, #content, .post, .article').first();
    const target = main.length ? main : $('body');

    target.find('h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,code').each((_, el) => {
      const tag = el.tagName.toLowerCase();
      const text = $(el).text().trim();
      if (!text) return;
      if (tag === 'h1') md += `# ${text}\n\n`;
      else if (tag === 'h2') md += `## ${text}\n\n`;
      else if (tag === 'h3') md += `### ${text}\n\n`;
      else if (tag.startsWith('h')) md += `#### ${text}\n\n`;
      else if (tag === 'li') md += `- ${text}\n`;
      else if (tag === 'blockquote') md += `> ${text}\n\n`;
      else if (tag === 'pre' || tag === 'code') md += `\`\`\`\n${text}\n\`\`\`\n\n`;
      else md += `${text}\n\n`;
    });

    return ok(md.slice(0, 20000));
  }

  // Plain text
  const text = $('body').text().replace(/\s+/g, ' ').trim();
  return ok(`[${title}]\nSource: ${url}\n\n${text.slice(0, 20000)}`);
}

async function tool_web_search({ query, max_results = 5 }) {
  if (!query || !query.trim()) return err('Search query cannot be empty');
  const limit = Math.min(Number(max_results) || 5, 10);

  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(searchUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html'
    },
    timeout: 15000
  });

  if (!res.ok) return err(`Search failed: HTTP ${res.status}`);

  const html = await res.text();
  const $ = cheerio.load(html);
  const results = [];

  $('.result').slice(0, limit).each((_, el) => {
    const titleEl = $(el).find('.result__a');
    const snippetEl = $(el).find('.result__snippet');
    const urlEl = $(el).find('.result__url');

    const title = titleEl.text().trim();
    const snippet = snippetEl.text().trim();
    const href = titleEl.attr('href') || '';

    // DuckDuckGo wraps URLs
    let cleanUrl = href;
    try {
      const u = new URL(href, 'https://duckduckgo.com');
      cleanUrl = u.searchParams.get('uddg') || u.searchParams.get('u') || href;
    } catch {}

    if (title) results.push({ title, url: cleanUrl, snippet });
  });

  if (!results.length) return ok(`No results found for: "${query}"`);

  let output = `## Search Results for: "${query}"\n\n`;
  results.forEach((r, i) => {
    output += `### ${i + 1}. ${r.title}\n`;
    output += `**URL:** ${r.url}\n`;
    if (r.snippet) output += `${r.snippet}\n`;
    output += '\n';
  });

  return ok(output);
}

function tool_memory_store({ key, value }) {
  if (!key || !key.trim()) return err('Key cannot be empty');
  if (!value) return err('Value cannot be empty');

  const safeKey = key.trim().slice(0, 200);
  const now = new Date().toISOString();
  db.set(`memories.${safeKey}`, { value, updated_at: now }).write();
  return ok(`Memory "${safeKey}" stored successfully.`);
}

function tool_memory_get({ key, list_all }) {
  const memories = db.get('memories').value() || {};
  if (list_all || !key) {
    const keys = Object.keys(memories);
    if (!keys.length) return ok('No memories stored yet. Use memory_store to save information.');
    let out = `## Stored Memories (${keys.length} total)\n\n`;
    keys.forEach(k => { out += `- **${k}** _(saved: ${memories[k].updated_at})_\n`; });
    return ok(out);
  }

  const safeKey = key.trim();
  const entry = memories[safeKey];
  if (!entry) {
    const hint = Object.keys(memories).length ? `\n\nAvailable keys: ${Object.keys(memories).join(', ')}` : '';
    return err(`Memory "${safeKey}" not found.${hint}`);
  }
  return ok(`## Memory: "${safeKey}"\n_Last updated: ${entry.updated_at}_\n\n${entry.value}`);
}

function tool_file_write({ filename, content }) {
  if (!filename || !filename.trim()) return err('Filename cannot be empty');
  if (!content) return err('Content cannot be empty');

  // Sanitize filename but keep dots — use bracket notation to avoid lowdb nested path issue
  const safeName = filename.trim().replace(/[^a-zA-Z0-9._\-]/g, '_').slice(0, 100);
  const now = new Date().toISOString();
  // Use bracket notation via lodash path to avoid dots being treated as nested keys
  const files = db.get('files').value() || {};
  files[safeName] = { content, updated_at: now, size: content.length };
  db.set('files', files).write();
  return ok(`File "${safeName}" written successfully (${content.length} characters).`);
}

function tool_file_read({ filename, list_files }) {
  const files = db.get('files').value() || {};
  if (list_files || !filename) {
    const names = Object.keys(files);
    if (!names.length) return ok('No files stored yet. Use file_write to create files.');
    let out = `## Stored Files (${names.length} total)\n\n`;
    names.forEach(n => { out += `- **${n}** — ${files[n].size} chars _(${files[n].updated_at})_\n`; });
    return ok(out);
  }

  const safeName = filename.trim().replace(/[^a-zA-Z0-9._\-]/g, '_').slice(0, 100);
  const entry = files[safeName];
  if (!entry) {
    const hint = Object.keys(files).length ? `\n\nAvailable files: ${Object.keys(files).join(', ')}` : '';
    return err(`File "${safeName}" not found.${hint}`);
  }
  return ok(`## File: "${safeName}"\n_Last updated: ${entry.updated_at}_\n\n${entry.content}`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function ok(text) { return { content: [{ type: 'text', text }] }; }
function err(msg) { return { isError: true, content: [{ type: 'text', text: `Error: ${msg}` }] }; }

async function callTool(name, args) {
  const start = Date.now();
  try {
    switch (name) {
      case 'web_fetch':   return await tool_web_fetch(args);
      case 'web_search':  return await tool_web_search(args);
      case 'memory_store': return tool_memory_store(args);
      case 'memory_get':  return tool_memory_get(args);
      case 'file_write':  return tool_file_write(args);
      case 'file_read':   return tool_file_read(args);
      default: return err(`Unknown tool: ${name}. Available: ${MCP_TOOLS.map(t => t.name).join(', ')}`);
    }
  } catch (e) {
    return err(`Tool execution failed: ${e.message}`);
  }
}

// ─── JSON-RPC helpers ─────────────────────────────────────────────────────────
const rpcOk  = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcErr = (id, code, msg) => ({ jsonrpc: '2.0', id, error: { code, message: msg } });

// ─── CORS Middleware ──────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// ─── MCP HTTP Endpoint (POST /mcp) ───────────────────────────────────────────
app.post('/mcp', async (req, res) => {
  const { id, method, params } = req.body || {};

  if (!req.body || req.body.jsonrpc !== '2.0') {
    return res.status(400).json(rpcErr(null, -32600, 'Invalid JSON-RPC'));
  }

  try {
    switch (method) {
      case 'initialize':
        return res.json(rpcOk(id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'mcp-tools-server', version: '1.0.0' },
          instructions: 'MCP server with 6 tools: web_fetch, web_search, memory_store, memory_get, file_read, file_write'
        }));

      case 'notifications/initialized':
        return res.status(204).end();

      case 'tools/list':
        return res.json(rpcOk(id, { tools: MCP_TOOLS }));

      case 'tools/call': {
        const result = await callTool(params?.name, params?.arguments || {});
        return res.json(rpcOk(id, result));
      }

      case 'ping':
        return res.json(rpcOk(id, {}));

      default:
        return res.json(rpcErr(id, -32601, `Method not found: ${method}`));
    }
  } catch (e) {
    return res.status(500).json(rpcErr(id, -32603, `Internal error: ${e.message}`));
  }
});

// ─── MCP SSE Endpoint (GET /mcp/sse) ─────────────────────────────────────────
app.get('/mcp/sse', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  const postUrl = `${proto}://${host}/mcp`;

  res.write(`event: endpoint\ndata: ${postUrl}\n\n`);

  const ping = setInterval(() => {
    if (res.writableEnded) return clearInterval(ping);
    res.write(`event: ping\ndata: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`);
  }, 25000);

  req.on('close', () => clearInterval(ping));
});

// ─── Health / Info ────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    name: 'MCP Tools Server',
    version: '1.0.0',
    protocol: 'MCP 2024-11-05',
    endpoints: { http: '/mcp', sse: '/mcp/sse' },
    tools: MCP_TOOLS.map(t => ({ name: t.name, description: t.description }))
  });
});

app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`MCP Tools Server running on port ${PORT}`);
  console.log(`Tools: ${MCP_TOOLS.map(t => t.name).join(', ')}`);
});
