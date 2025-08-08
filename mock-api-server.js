const express = require('express');
const app = express();
const PORT = 3001;

app.use(express.json());

// Mock Image Generation API
app.post('/api/generate-image', (req, res) => {
  console.log('Image generation request:', req.body);
  res.json({
    imageUrl: 'https://via.placeholder.com/400x400/0066FF/FFFFFF?text=' + encodeURIComponent(req.body.prompt || 'Generated Image')
  });
});

// Mock Video Generation API  
app.post('/api/generate-video', (req, res) => {
  console.log('Video generation request:', req.body);
  res.json({
    videoUrl: 'https://sample-videos.com/zip/10/mp4/SampleVideo_1280x720_1mb.mp4'
  });
});

// Mock Information API
app.post('/api/get-info', (req, res) => {
  console.log('Info request:', req.body);
  res.json({
    response: `Here's information about: ${req.body.query}. This is a mock response for local testing.`
  });
});

app.listen(PORT, () => {
  console.log(`Mock API server running on port ${PORT}`);
});