import path from 'path';
import express from 'express';
import webpack from 'webpack';
import webpackMiddleware from 'webpack-dev-middleware';
import webpackHotMiddleware from 'webpack-hot-middleware';
import wrap from 'express-async-wrap';
import fs from 'fs-promise';
import compress from 'compression';

import search from '../common/search';
import webpackConfig from './webpack.config.babel';
import macros from './macros';

const app = express();
app.use(compress()); // gzip the output

// Prevent being in an iFrame.
app.use(function (req, res, next) {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("X-Content-Type-Options", "nosniff");

  if (macros.PROD) {
    // Assets are cached for a day. 
    // This time interval was chosen because the scrapers are ran daily, so there is no point for the browser to update the cache more often that this. 
    // These Cache-control headers are far from perfect though haha
    res.setHeader('Cache-Control', 'public, max-age=86400');
  }
  else {

    // Don't cache in DEV
    // Could also use no-store which would prevent the browser from storing it all.
    // This no-cache header requires the browser to revalidate the cache with the server before serving it.
    res.setHeader('Cache-Control', 'no-cache');
  }
  next()
}.bind(this))


// Http to https redirect. 
app.use(function (req, res, next) {
  
  var remoteIp = req.connection.remoteAddress;


  // If this is https request, done. 
  if (req.protocol === 'https') {
    next()
  }

  // If we are behind a cloudflare proxy and cloudflare served a https response, done. 
  else if (req.headers['x-forwarded-proto'] && req.headers['x-forwarded-proto'] === 'https') {
    next()
  }

  // This is development mode
  else if (macros.DEV) {
    next()
  }

  // This is prod and still on http, redirect to https. 
  else {
    // Cache the http to https redirect for 2 months. 
    res.setHeader('Cache-Control', 'public, max-age=5256000');
    console.log(remoteIp, 'redirecting to https')
    res.redirect('https://' + req.get('host') + req.originalUrl);
  }
})



let searchPromise = null;

async function getSearch() {
  if (searchPromise) {
    return searchPromise;
  }

  const termDumpPromise = fs.readFile('./public/data/getTermDump/neu.edu/201810.json').then((body) => {
    return JSON.parse(body);
  });

  const searchIndexPromise = fs.readFile('./public/data/getSearchIndex/neu.edu/201810.json').then((body) => {
    return JSON.parse(body);
  });


  const employeeMapPromise = fs.readFile('./public/data/employeeMap.json').then((body) => {
    return JSON.parse(body);
  });

  const employeesSearchIndexPromise = fs.readFile('./public/data/employeesSearchIndex.json').then((body) => {
    return JSON.parse(body);
  });

  try {
    searchPromise = Promise.all([termDumpPromise, searchIndexPromise, employeeMapPromise, employeesSearchIndexPromise]).then((...args) => {
      return search.create(...args[0]);
    });
  }
  catch (e) {
    console.error("Error:", e)
    console.error('Not starting search backend.')
    return null;
  }

  return searchPromise;
}

// Load the index as soon as the app starts. 
getSearch();

app.get('/search', wrap(async (req, res) => {
  if (!req.query.query || typeof req.query.query !== 'string' || req.query.query.length > 500) {
    console.error('Need query.');
    res.send('Need query param.');
    return;
  }

  if (!macros.isNumeric(req.query.minIndex) || !macros.isNumeric(req.query.maxIndex)) {
    console.log("Need numbers as max and min index.")
    res.send("Max and Min index must be numbers.")
    return;
  }

  let minIndex = 0;
  if (req.query.minIndex) {
    minIndex = parseInt(req.query.minIndex);
  }

  let maxIndex = 10;
  if (req.query.maxIndex) {
    maxIndex = parseInt(req.query.maxIndex);
  } 


  const index = await getSearch();

  if (!index) {

    // Don't cache errors.
    res.setHeader('Cache-Control', 'no-cache, no-store');
    res.send('Could not start backend. No data found.')
    return;
  }

  const startTime = Date.now();
  const results = index.search(req.query.query, minIndex, maxIndex);
  const midTime = Date.now();
  const string = JSON.stringify(results)
  console.log(req.connection.remoteAddress, 'Search for', req.query.query, 'took ', midTime-startTime, 'ms and stringify took', Date.now()-midTime, 'with', results.length, 'results');

  res.send(string);
}));


let middleware;

if (macros.DEV) {

  const compiler = webpack(webpackConfig);
  middleware = webpackMiddleware(compiler, {
    publicPath: webpackConfig.output.publicPath,
    stats: {
      colors: true,
      timings: true,
      hash: false,
      chunksM: false,
      chunkModules: false,
      modules: false,
    },
  });

  app.use(middleware);
  app.use(webpackHotMiddleware(compiler));
}


app.use(express.static('public'));

app.get('/sw.js', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'sw.js'));
});

// Google Search Console Site Verification. 
// I could make this a static file... but it is never going to change so though this would be easier. 
// If this is removed, the domain will no longer be verified with Google. 
app.get('/google840b636639b40c3c.html', (req, res) => {
  res.write('google-site-verification: google840b636639b40c3c.html')
  res.end();
})


app.get('*', (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=UTF-8");
  if (macros.PROD) {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  }
  else {
    res.write(middleware.fileSystem.readFileSync(path.join(webpackConfig.output.path, 'index.html')));
    res.end();
  }
});


let port;
if (macros.DEV) {
  port = 5000;
}
else {
  port = 80;
}


app.listen(port, '0.0.0.0', (err) => {
  if (err) console.log(err);
  console.info(`Listening on port ${port}.`);
});
