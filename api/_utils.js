const http = require('http');
const https = require('https');
const url = require('url');
const zlib = require('zlib');

const BASE_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive'
};

function fetchWithHeaders(targetUrl, customHeaders = {}) {
    return new Promise((resolve, reject) => {
        const parsed = url.parse(targetUrl);
        const client = parsed.protocol === 'https:' ? https : http;
        const dynamicOrigin = `${parsed.protocol}//${parsed.hostname}`;
        
        const options = {
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
            path: parsed.path,
            method: 'GET',
            headers: { 
                ...BASE_HEADERS, 
                'Origin': dynamicOrigin,
                'Referer': dynamicOrigin + '/',
                ...customHeaders 
            },
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
                    try { data = zlib.gunzipSync(buffer); } catch (e) { data = buffer; }
                } else if (encoding === 'deflate') {
                    try { data = zlib.inflateSync(buffer); } catch (e) { data = buffer; }
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

function rewriteM3U8(m3u8Content, baseUrl) {
    const base = new URL(baseUrl);
    const baseOrigin = base.origin;
    const proxyBase = '';
    
    const lines = m3u8Content.split('\n');
    const rewritten = lines.map(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
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

function setCorsHeaders(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range');
    
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return true;
    }
    return false;
}

module.exports = {
    fetchWithHeaders,
    rewriteM3U8,
    setCorsHeaders
};
