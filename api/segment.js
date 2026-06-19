const { fetchWithHeaders, setCorsHeaders } = require('./_utils');

module.exports = async (req, res) => {
    if (setCorsHeaders(req, res)) return;
    
    const segmentUrl = req.query.url;
    if (!segmentUrl) {
        return res.status(400).send('Missing url');
    }
    
    try {
        const result = await fetchWithHeaders(segmentUrl);
        const contentType = result.headers['content-type'] || 
            (segmentUrl.includes('.key') ? 'application/octet-stream' : 
             segmentUrl.includes('.ts') ? 'video/MP2T' : 'application/octet-stream');
        
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Length', result.body.length);
        res.status(result.status).send(result.body);
    } catch (err) {
        res.status(500).send(err.message);
    }
};
