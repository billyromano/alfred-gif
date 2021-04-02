const fs    = require("fs");
const http  = require("http");
const https = require("https");
const path  = require("path");

const { lookup } = require("lookup-dns-cache");

const { data: MOCK_DATA } = require("./mock-giphy-data.json");
const USE_MOCK            = false;
const terminate           = require("./terminate");

// https://nodejs.org/api/http.html#http_http_get_options_callback
const REQUEST_OPTS = {
    family: 4,
    lookup: lookup,
};

String.prototype.title = function () {
    return this.replace(/(^|\s)\S/g, (t) => t.toUpperCase());
};

// Negative indices for arrays
Array.prototype.get = function (i) {
    return this[(i + this.length) % this.length];
};


const CACHE_DIR = (() => {
    let cache = process.env.alfred_workflow_cache;
    if (!cache) {
        let HOME = process.env.HOME;
        cache    = `${HOME}/Library/Caches/com.runningwithcrayons.Alfred` +
            "/Workflow Data/billyromano.gif";
    }
    if (!fs.existsSync(cache)) {
        fs.mkdirSync(cache, { recursive: true });
    }

    let runtimeAssets = [
        "gif-browser.css",
        "gif-navigator.js",
        "smoothscroll.js",
    ];

    runtimeAssets.forEach((asset) => {
        let src  = path.join(__dirname, asset);
        let dest = path.join(cache, asset);
        if (!fs.existsSync(dest)) {
            // need to read then write as copyFileSync doesn't work
            // with pkg's snapshot filesystem
            // https://github.com/vercel/pkg/issues/420
            fs.writeFileSync(dest, fs.readFileSync(src));
        }
    });

    return cache;
})();


function makeHtml(gifInfos) {
    const N_COLS = 3;
    let cols     = [];
    for (let i = 0; i < N_COLS; i++) {
        cols.push([]);
        // because the footer might hide the bottom gifs partly,
        // for each column, add one extra gif at the bottom.
        gifInfos.push(gifInfos[i]);
    }

    gifInfos.forEach((gif, i) => {
        let markup = `<img class="cell" src="${gif.url}" title="${gif.title}">`;
        cols[i % N_COLS].push(markup);
    });

    let grid = cols.map((col) =>
        `<div class="column">${col.join("")}</div>`,
    ).join("");

    return `
    <html>
      <head>
        <meta http-equiv="Content-Type" content="text/html; charset=utf-8"/>
        <script type="text/javascript" src="smoothscroll.js"></script>
        <script type="text/javascript" src="gif-navigator.js"></script>
        <link rel="stylesheet" href="gif-browser.css">
      </head>
      <body>
        ${grid}
        <footer>
          <span id="caption"></span>
          <span id="credits">Powered by Giphy</span>
        </footer>
      </body>
    </html>`;
}


function makeAlfredResponse(htmlPath) {
    return {
        "items": [
            {
                "arg":          "dummy",
                "valid":        true,
                "title":        "Select with arrow keys, drag-n-drop with mouse",
                "subtitle":
                                "[↩: search again] [⌘: copy GIF] [⌥: copy URL]",
                "quicklookurl": htmlPath,
            },
        ],
    };
}


function parseData(data, query) {
    let htmlName =
            query
                .toLowerCase()
                .replace(/[^0-9a-z ]/gi, "")
                .replace(" ", "-");
    let htmlPath = `${CACHE_DIR}/_${htmlName}.html`;

    !USE_MOCK && ({ data } = data);
    // let gifInfos = data.results.map((item) => {
    let gifInfos = data.map((item) => {
        // Example tinygif url:
        // https://c.tenor.com/-bHlmkHiqoQAAAAM/harry-potter-dobby.gif
        // Example Giphy URL:
        // https://media0.giphy.com/media/xL7PDV9frcudO/giphy.gif?cid=ecf05e4724cfeb7eb430ff21d644ebf5519d3b6a26081f82&rid=giphy.gif&ct=g
        // let gifUrl  = item.media_formats.tinygif.url;
        let gifUrl  = item.images.downsized.url;
        let gifHash = gifUrl.split("/").get(-2);
        let gifPath = `${CACHE_DIR}/${gifHash}.gif`;

        // Example itemurl: https://tenor.com/view/freaking-out-kermit-gif-8832122
        // Title we want  : Freaking Out Kermit
        // let title =
        //         decodeURI(item.itemurl)
        //             .split("/")[4]
        //             .split("-").slice(0, -2)
        //             .join(" ")
        //             .title();

        let title = item.title;

        return {
            "url":   gifUrl,
            "path":  gifPath,
            "title": title,
        };
    });

    fs.exists(htmlPath, (exists) => {
        if (!exists) {
            fs.writeFile(
                htmlPath,
                makeHtml(gifInfos),
                (err) => {
                    if (err) {
                        console.error(err);
                    } else {
                        console.log(`Created ${htmlPath}`);
                    }
                },
            );
        } else {
            console.log(`${htmlPath} already cached`);
        }
    });

    return {
        "gifs":           gifInfos,
        "alfredResponse": makeAlfredResponse(htmlPath),
    };
}


async function downloadGifs(gifs) {
    gifs.forEach((gif) => {
        fs.exists(gif.path, (exists) => {
            if (!exists) {
                const stream = fs.createWriteStream(gif.path);
                const getter = gif.url.startsWith("https:") ? https : http;
                getter.get(gif.url, REQUEST_OPTS, (response) => {
                    console.log(`Downloading ${gif.url}`);
                    response.pipe(stream);
                });
            } else {
                console.log(`${gif.url} already downloaded`);
            }
        });
    });
}


const server = http.createServer(function (req, res) {
    let url   = new URL(req.url, `http://${req.headers.host}`);
    let query = url.searchParams.get("query");
    if (query === null) return; // prevent other calls

    let cachedHtmlName = `${query.toLowerCase().split(" ").join("-")}-gifs.html`;
    let cachedHtmlPath = `${CACHE_DIR}/${cachedHtmlName}`;

    if (fs.existsSync(cachedHtmlPath)) {
        res.write(JSON.stringify(makeAlfredResponse(cachedHtmlPath)));
        res.end();
        console.log("Responded to alfred from cache");
        res = {
            "write": (_) => {
            },
            "end":   () => {
            },
        };
        // we might have the cached html but still, maybe last time,
        // not all GIFs were downloaded. Hence, we don't just return here.
    }

    let apiEndpoint = new URL("https://api.giphy.com/v1/gifs/search");
    apiEndpoint.searchParams.append("api_key", "F8Qdf6c65ueUFhRcRn8X6z3kswMyzK65");
    apiEndpoint.searchParams.append("q", query);
    apiEndpoint.searchParams.append("limit", "50");
    apiEndpoint.searchParams.append("offset", "0");
    apiEndpoint.searchParams.append("lang", "en");

    https.get(apiEndpoint, REQUEST_OPTS, (response) => {
        const { statusCode } = response;
        const contentType    = response.headers["content-type"];

        let error;
        // Any 2xx status code signals a successful response but
        // here we're only checking for 200.
        if (statusCode !== 200) {
            error = new Error(
                `Request Failed.\nStatus Code: ${statusCode}`,
            );
        } else if (!/^application\/json/.test(contentType)) {
            error = new Error(
                "Invalid content-type.\n" +
                `Expected application/json but received ${contentType}`,
            );
        }

        if (error) {
            console.error(error.message);

            // Consume response data to free up memory
            response.resume();

            res.write(error.message);
            res.end();
            return;
        }

        response.setEncoding("utf8");
        let rawData = "";
        response.on("data", (chunk) => {
            rawData += chunk;
        });
        response.on("end", () => {
            try {
                const data = USE_MOCK && MOCK_DATA || JSON.parse(rawData);
                const parsed = parseData(data, query);
                res.write(JSON.stringify(parsed.alfredResponse));
                res.end();
                console.log("Responded to alfred");
                downloadGifs(parsed.gifs);
            } catch (e) {
                console.error(e.message);
                res.write(e.message);
                res.end();
            }
        });
    }).on("error", (e) => {
        console.error(`Got error: ${e.message}`);
        res.write(e.message);
        res.end();
    });

    console.log(url.searchParams);
}).listen(8910);


const exitHandler = terminate(server, {
    coredump: false,
    timeout:  500,
});

process.on("uncaughtException", exitHandler(1, "Unexpected Error"));
process.on("unhandledRejection", exitHandler(1, "Unhandled Promise"));
process.on("SIGTERM", exitHandler(0, "SIGTERM"));
process.on("SIGINT", exitHandler(0, "SIGINT"));
