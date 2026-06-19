const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PORT = 8765;

// Spoofed headers to bypass site protection
const SPOOF_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Referer': 'https://a9.kora-plus.app/',
    'Origin': 'https://a9.kora-plus.app',
    'Connection': 'keep-alive'
};

// Fetch with spoofed headers and gzip support
function fetchWithHeaders(targetUrl, customHeaders = {}) {
    return new Promise((resolve, reject) => {
        const parsed = url.parse(targetUrl);
        const client = parsed.protocol === 'https:' ? https : http;
        
        const options = {
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
            path: parsed.path,
            method: 'GET',
            headers: { ...SPOOF_HEADERS, ...customHeaders },
            rejectUnauthorized: false,
            timeout: 15000
        };
        
        const req = client.request(options, (res) => {
            let chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const buffer = Buffer.concat(chunks);
                const encoding = res.headers['content-encoding'];
                
                let data;
                if (encoding === 'gzip') {
                    try {
                        data = zlib.gunzipSync(buffer);
                    } catch (e) {
                        data = buffer;
                    }
                } else if (encoding === 'deflate') {
                    try {
                        data = zlib.inflateSync(buffer);
                    } catch (e) {
                        data = buffer;
                    }
                } else {
                    data = buffer;
                }
                
                resolve({ status: res.statusCode, headers: res.headers, body: data });
            });
        });
        
        req.on('error', reject);
        req.on('timeout', () => reject(new Error('Timeout')));
        req.end();
    });
}

// Extract streams from HTML
function extractStreams(html, baseUrl) {
    const streams = [];
    const seen = new Set();
    
    const addStream = (url, type, source) => {
        if (!url || seen.has(url)) return;
        seen.add(url);
        
        if (url.startsWith('//')) url = 'https:' + url;
        else if (url.startsWith('/')) {
            const base = new URL(baseUrl);
            url = base.origin + url;
        } else if (!url.startsWith('http')) {
            const base = new URL(baseUrl);
            url = base.origin + '/' + url;
        }
        
        streams.push({ url, type, source });
    };
    
    const m3u8Matches = html.match(/(https?:\/\/[^\s"']+\.m3u8(?:\?[^\s"']*)?)/gi);
    if (m3u8Matches) m3u8Matches.forEach(u => addStream(u.replace(/["']/g, ''), 'M3U8', 'DIRECT'));
    
    const srcMatches = html.match(/(?:src|source|file|data-url|data-stream)\s*=\s*["']([^"']+)["']/gi);
    if (srcMatches) {
        srcMatches.forEach(m => {
            const match = m.match(/["']([^"']+)["']/);
            if (match) addStream(match[1], 'SRC', 'ATTRIBUTE');
        });
    }
    
    const scriptMatches = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi);
    if (scriptMatches) {
        scriptMatches.forEach(script => {
            const content = script.replace(/<script[^>]*>|<\/script>/gi, '');
            const m3u8InScript = content.match(/(https?:\/\/[^\s"']+\.m3u8[^\s"']*)/gi);
            if (m3u8InScript) m3u8InScript.forEach(u => addStream(u.replace(/["']/g, ''), 'M3U8', 'SCRIPT'));
        });
    }
    
    return streams;
}

// Rewrite M3U8 to proxy all segments through us
function rewriteM3U8(m3u8Content, baseUrl) {
    const base = new URL(baseUrl);
    const baseOrigin = base.origin;
    const proxyBase = `http://localhost:${PORT}`;
    
    const lines = m3u8Content.split('\n');
    const rewritten = lines.map(line => {
        const trimmed = line.trim();
        
        // Skip comments and empty lines
        if (!trimmed || trimmed.startsWith('#')) {
            // But check for KEY URI that needs rewriting
            if (trimmed.startsWith('#EXT-X-KEY')) {
                return line.replace(/URI="([^"]+)"/, (match, uri) => {
                    let fullUri = uri;
                    if (uri.startsWith('/')) {
                        fullUri = baseOrigin + uri;
                    } else if (!uri.startsWith('http')) {
                        fullUri = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1) + uri;
                    }
                    return `URI="${proxyBase}/api/segment?url=${encodeURIComponent(fullUri)}"`;
                });
            }
            return line;
        }
        
        // It's a segment URL - rewrite to proxy
        let segmentUrl = trimmed;
        if (segmentUrl.startsWith('/')) {
            segmentUrl = baseOrigin + segmentUrl;
        } else if (!segmentUrl.startsWith('http')) {
            segmentUrl = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1) + segmentUrl;
        }
        
        return `${proxyBase}/api/segment?url=${encodeURIComponent(segmentUrl)}`;
    });
    
    return rewritten.join('\n');
}

// HTTP Server
const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range');
    res.setHeader('Access-Control-Max-Age', '86400');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }
    
    const parsedUrl = url.parse(req.url, true);
    
    // Serve the HTML file
    if (parsedUrl.pathname === '/' || parsedUrl.pathname === '/index.html') {
        const htmlPath = path.join(__dirname, 'index.html');
        if (fs.existsSync(htmlPath)) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(fs.readFileSync(htmlPath));
        } else {
            res.writeHead(404);
            res.end('index.html not found');
        }
        return;
    }
    
    // API: Fetch and scrape a target URL
    if (parsedUrl.pathname === '/api/fetch') {
        const targetUrl = parsedUrl.query.url;
        if (!targetUrl) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing url parameter' }));
            return;
        }
        
        try {
            console.log(`[PROXY] Fetching: ${targetUrl}`);
            const result = await fetchWithHeaders(targetUrl);
            console.log(`[PROXY] Status: ${result.status}, Length: ${result.body.length}`);
            
            const bodyStr = result.body.toString('utf8');
            const streams = extractStreams(bodyStr, targetUrl);
            console.log(`[PROXY] Found ${streams.length} streams`);
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                status: result.status,
                html_length: bodyStr.length,
                streams: streams,
                html_preview: bodyStr.substring(0, 3000)
            }));
        } catch (err) {
            console.error(`[PROXY] Error: ${err.message}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
        }
        return;
    }
    
    // API: Proxy an M3U8 stream (for playback)
    if (parsedUrl.pathname === '/api/stream') {
        const streamUrl = parsedUrl.query.url;
        if (!streamUrl) {
            res.writeHead(400);
            res.end('Missing url');
            return;
        }
        
        try {
            console.log(`[PROXY] Streaming M3U8: ${streamUrl}`);
            const result = await fetchWithHeaders(streamUrl);
            
            const m3u8Content = result.body.toString('utf8');
            
            if (m3u8Content.includes('#EXTM3U')) {
                // Rewrite the M3U8 to proxy all segments
                const rewritten = rewriteM3U8(m3u8Content, streamUrl);
                
                res.writeHead(200, {
                    'Content-Type': 'application/vnd.apple.mpegurl',
                    'Access-Control-Allow-Origin': '*',
                    'Content-Length': Buffer.byteLength(rewritten)
                });
                res.end(rewritten);
            } else {
                // Not a valid M3U8, return as-is
                res.writeHead(result.status, {
                    'Content-Type': result.headers['content-type'] || 'application/octet-stream',
                    'Access-Control-Allow-Origin': '*'
                });
                res.end(result.body);
            }
        } catch (err) {
            console.error(`[PROXY] Stream error: ${err.message}`);
            res.writeHead(500);
            res.end(err.message);
        }
        return;
    }
    
    // API: Proxy segments (TS files, keys, etc)
    if (parsedUrl.pathname === '/api/segment') {
        const segmentUrl = parsedUrl.query.url;
        if (!segmentUrl) {
            res.writeHead(400);
            res.end('Missing url');
            return;
        }
        
        try {
            console.log(`[PROXY] Segment: ${segmentUrl.substring(0, 80)}`);
            const result = await fetchWithHeaders(segmentUrl);
            
            const contentType = result.headers['content-type'] || 
                (segmentUrl.includes('.key') ? 'application/octet-stream' : 
                 segmentUrl.includes('.ts') ? 'video/MP2T' : 'application/octet-stream');
            
            res.writeHead(result.status, {
                'Content-Type': contentType,
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Expose-Headers': 'Content-Length, Content-Range',
                'Content-Length': result.body.length
            });
            res.end(result.body);
        } catch (err) {
            console.error(`[PROXY] Segment error: ${err.message}`);
            res.writeHead(500);
            res.end(err.message);
        }
        return;
    }
    
    // 404
    res.writeHead(404);
    res.end('Not found');
});

const PROXY_URL = `http://localhost:${PORT}`;

server.listen(PORT, () => {
    console.log('');
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║           KORA STREAM PROXY SERVER                       ║');
    console.log('╠══════════════════════════════════════════════════════════╣');
    console.log(`║  Server running on: http://localhost:${PORT}              ║`);
    console.log('║                                                          ║');
    console.log('║  Open this URL in your browser:                          ║');
    console.log(`║  http://localhost:${PORT}                                 ║`);
    console.log('║                                                          ║');
    console.log('║  AES-128 DRM support enabled                             ║');
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log('');
});
