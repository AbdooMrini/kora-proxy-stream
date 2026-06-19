const { fetchWithHeaders, rewriteM3U8, setCorsHeaders } = require('./_utils');

module.exports = async (req, res) => {
    if (setCorsHeaders(req, res)) return;
    
    const streamUrl = req.query.url;
    if (!streamUrl) {
        return res.status(400).send('Missing url');
    }
    
    try {
        const result = await fetchWithHeaders(streamUrl);
        const m3u8Content = result.body.toString('utf8');
        
        if (m3u8Content.includes('#EXTM3U')) {
            const rewritten = rewriteM3U8(m3u8Content, streamUrl);
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            res.setHeader('Content-Length', Buffer.byteLength(rewritten));
            res.status(200).send(rewritten);
        } else {
            res.setHeader('Content-Type', result.headers['content-type'] || 'application/octet-stream');
            res.status(result.status).send(result.body);
        }
    } catch (err) {
        res.status(500).send(err.message);
    }
};
