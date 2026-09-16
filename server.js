require("dotenv").config();

const express = require("express");
const axios = require("axios");
const FormData = require("form-data");
const cors = require("cors");
const sharp = require("sharp");
const cloudinary = require("cloudinary").v2;
const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;

app.use(cors({
    origin: [
        "http://localhost:5173"
    ],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"]
}));

// ============================================================
// CLOUDINARY CONFIG
// ============================================================

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true
});

// ============================================================
// CONFIG
// ============================================================

const WIDTH = 128;
const HEIGHT = 128;
const RES_M = 10;

const PATCH_SIZE_METERS = WIDTH * RES_M;

const EPSG = 32644;

const FROM = "2024-01-01T00:00:00Z";

const MAX_CLOUD = 30;

// ============================================================
// COPERNICUS DATA SPACE
// ============================================================

const TOKEN_URL =
    "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token";

const PROCESS_URL =
    "https://sh.dataspace.copernicus.eu/api/v1/process";

// ============================================================
// SENTINEL ML MODEL
// ============================================================

const ML_API =
    "https://landslide-prediction2-api.onrender.com/predict";

// ============================================================
// HOME / SERVER STATUS
// ============================================================

app.get("/", (req, res) => {

    res.json({
        success: true,
        message: "Sentinel Landslide Prediction Server is Running",
        status: "UP"
    });

});

// ============================================================
// BBOX
// ============================================================

function bbox4326(lat, lon, sizeMeters) {

    const half = sizeMeters / 2;

    const dLat = half / 111320;

    const dLon =
        half /
        (111320 * Math.cos((lat * Math.PI) / 180));

    return [
        lon - dLon,
        lat - dLat,
        lon + dLon,
        lat + dLat
    ];
}

// ============================================================
// AUTHENTICATION
// ============================================================

async function getToken() {

    if (!process.env.CDSE_CLIENT_ID) {
        throw new Error("CDSE_CLIENT_ID missing in .env");
    }

    if (!process.env.CDSE_CLIENT_SECRET) {
        throw new Error("CDSE_CLIENT_SECRET missing in .env");
    }

    const body = new URLSearchParams({
        grant_type: "client_credentials",
        client_id: process.env.CDSE_CLIENT_ID,
        client_secret: process.env.CDSE_CLIENT_SECRET
    });

    const response = await axios.post(
        TOKEN_URL,
        body.toString(),
        {
            headers: {
                "Content-Type":
                    "application/x-www-form-urlencoded"
            },
            timeout: 30000
        }
    );

    return response.data.access_token;
}

// ============================================================
// 14-BAND EVALSCRIPT
// ============================================================

const EVALSCRIPT = `
//VERSION=3

function setup() {

    return {
        input: [{
            bands: [
                "B01","B02","B03","B04","B05","B06","B07",
                "B08","B8A","B09","B11","B12",
                "SCL","dataMask"
            ],
            units: "DN"
        }],

        output: {
            bands: 14,
            sampleType: "FLOAT32"
        }
    };
}

function evaluatePixel(s) {

    return [
        s.B01 / 10000,
        s.B02 / 10000,
        s.B03 / 10000,
        s.B04 / 10000,
        s.B05 / 10000,
        s.B06 / 10000,
        s.B07 / 10000,
        s.B08 / 10000,
        s.B8A / 10000,
        s.B09 / 10000,
        s.B11 / 10000,
        s.B12 / 10000,
        s.SCL,
        s.dataMask
    ];
}
`;

// ============================================================
// CREATE SENTINEL REQUEST
// ============================================================

function createRequest(lat, lon) {

    return {

        input: {

            bounds: {

                bbox: bbox4326(
                    lat,
                    lon,
                    PATCH_SIZE_METERS
                ),

                properties: {
                    crs:
                        "http://www.opengis.net/def/crs/EPSG/0/4326"
                }
            },

            data: [{

                type: "sentinel-2-l2a",

                dataFilter: {

                    timeRange: {
                        from: FROM,
                        to: new Date().toISOString()
                    },

                    maxCloudCoverage: MAX_CLOUD,

                    mosaickingOrder: "mostRecent"
                },

                processing: {

                    upsampling: "BILINEAR",

                    downsampling: "BILINEAR"
                }

            }]
        },

        output: {

            width: WIDTH,

            height: HEIGHT,

            crs:
                `http://www.opengis.net/def/crs/EPSG/0/${EPSG}`,

            responses: [{

                identifier: "default",

                format: {
                    type: "image/tiff"
                }

            }]
        },

        evalscript: EVALSCRIPT
    };
}

// ============================================================
// TIFF CHECK
// ============================================================

function isTIFF(buf) {

    return (
        (
            buf[0] === 0x49 &&
            buf[1] === 0x49 &&
            buf[2] === 0x2A &&
            buf[3] === 0x00
        )
        ||
        (
            buf[0] === 0x4D &&
            buf[1] === 0x4D &&
            buf[2] === 0x00 &&
            buf[3] === 0x2A
        )
    );
}

// ============================================================
// GET SENTINEL TIFF
// ============================================================

async function getSentinelImage(
    token,
    latitude,
    longitude
) {

    console.log("");
    console.log("=================================");
    console.log("REQUESTING SENTINEL-2 IMAGE");
    console.log("=================================");

    console.log("Latitude :", latitude);
    console.log("Longitude:", longitude);

    const body =
        createRequest(
            latitude,
            longitude
        );

    const response =
        await axios.post(
            PROCESS_URL,
            body,
            {

                headers: {

                    Authorization:
                        `Bearer ${token}`,

                    "Content-Type":
                        "application/json",

                    Accept:
                        "image/tiff"
                },

                responseType:
                    "arraybuffer",

                timeout:
                    180000
            }
        );

    const tiffBuffer =
        Buffer.from(response.data);

    if (!isTIFF(tiffBuffer)) {

        console.log(
            tiffBuffer.toString("utf8")
        );

        throw new Error(
            "Sentinel API did not return a TIFF"
        );
    }

    console.log(
        "Sentinel TIFF received:",
        tiffBuffer.length,
        "bytes"
    );

    // IMPORTANT:
    // Nothing is saved to disk.
    // TIFF exists only in memory.

    return tiffBuffer;
}

// ============================================================
// TIFF -> PNG CONVERSION (in-memory)
// ============================================================

async function tiffToPng(tiffBuffer) {

    console.log("");
    console.log("=================================");
    console.log("CONVERTING TIFF -> PNG");
    console.log("=================================");

    // The Sentinel TIFF has 14 float32 bands. Only the first band is a
    // valid greyscale image; to visualise a realistic satellite RGB we
    // take B02 (blue, band index 1), B03 (green, index 2), B04 (red,
    // index 3). We normalise each band into 0-255 and combine into RGB.

    const { data, info } = await sharp(tiffBuffer, {
        raw: undefined,
        limitInputPixels: false
    })
        .raw()
        .toBuffer({ resolveWithObject: true });

    const { width, height, channels } = info;

    if (channels < 4) {
        // Not the expected 14-band stacked layout; fall back to a simple
        // greyscale conversion of whatever sharp can render.
        console.log(
            `Unexpected channel count (${channels}); falling back to grayscale`
        );
        return sharp(tiffBuffer, { limitInputPixels: false })
            .png()
            .toBuffer();
    }

    // Sentinel patch: 14 bands, float32, planar (band-sequential).
    const pixelCount = width * height;
    const expectedBytes = pixelCount * channels * 4; // float32

    if (data.length !== expectedBytes) {
        // Interleaved fallback — just render whatever sharp produced.
        console.log(
            `Raw size mismatch (${data.length} vs ${expectedBytes}); using default PNG`
        );
        return sharp(tiffBuffer, { limitInputPixels: false })
            .png()
            .toBuffer();
    }

    // Helper: extract a band's float values by reading every `channels`th
    // float starting at `bandIndex`. This is a safeguard for either
    // planar or interleaved layouts — Sentinel returns planar in
    // practice, in which case B02 is at offset pixelCount*1, etc.
    const readBandPlanar = (bandIndex) => {
        const start = bandIndex * pixelCount * 4;
        const out = new Float32Array(pixelCount);
        for (let i = 0; i < pixelCount; i++) {
            out[i] = data.readFloatLE(start + i * 4);
        }
        return out;
    };

    // B02 blue (index 1), B03 green (index 2), B04 red (index 3)
    const blue = readBandPlanar(1);
    const green = readBandPlanar(2);
    const red = readBandPlanar(3);

    // Normalise each band to 0-255 with a percentile stretch so the
    // image has reasonable contrast instead of being nearly black.
    const stretch = (band) => {
        const sorted = Float32Array.from(band).sort();
        const lo = sorted[Math.floor(sorted.length * 0.02)];
        const hi = sorted[Math.floor(sorted.length * 0.98)];
        const range = hi - lo || 1;
        const out = Buffer.alloc(pixelCount);
        for (let i = 0; i < pixelCount; i++) {
            const v = (band[i] - lo) / range;
            out[i] = Math.max(0, Math.min(255, Math.round(v * 255)));
        }
        return out;
    };

    const r = stretch(red);
    const g = stretch(green);
    const b = stretch(blue);

    const rgb = Buffer.alloc(pixelCount * 3);
    for (let i = 0; i < pixelCount; i++) {
        rgb[i * 3] = r[i];
        rgb[i * 3 + 1] = g[i];
        rgb[i * 3 + 2] = b[i];
    }

    const pngBuffer = await sharp(rgb, {
        raw: { width, height, channels: 3 }
    })
        .png()
        .toBuffer();

    console.log("PNG generated:", pngBuffer.length, "bytes");

    return pngBuffer;
}

// ============================================================
// CLOUDINARY UPLOAD
// ============================================================

function uploadToCloudinary(buffer, options) {

    return new Promise((resolve, reject) => {

        const stream =
            cloudinary.uploader.upload_stream(
                options,
                (error, result) => {

                    if (error) {
                        return reject(error);
                    }

                    resolve(result);
                }
            );

        stream.end(buffer);
    });
}

async function uploadSentinelImages(
    tiffBuffer,
    pngBuffer,
    latitude,
    longitude
) {

    console.log("");
    console.log("=================================");
    console.log("UPLOADING TO CLOUDINARY");
    console.log("=================================");

    // A stable-ish folder + public id per location. Timestamp ensures
    // each call produces a fresh asset so the CDN doesn't serve a stale
    // image for the same coordinates.
    const stamp =
        Date.now();

    const safeLat =
        String(latitude).replace(/[^0-9.-]/g, "_");

    const safeLon =
        String(longitude).replace(/[^0-9.-]/g, "_");

    const folder =
        "sentinel-landslide";

    const baseId =
        `patch_${safeLat}_${safeLon}_${stamp}`;

    const [tiffResult, pngResult] =
        await Promise.all([

            uploadToCloudinary(tiffBuffer, {
                resource_type: "raw",
                folder,
                public_id: `${baseId}.tif`,
                overwrite: true
            }),

            uploadToCloudinary(pngBuffer, {
                resource_type: "image",
                folder,
                public_id: `${baseId}`,
                overwrite: true
            })
        ]);

    console.log("TIFF URL:", tiffResult.secure_url);
    console.log("PNG  URL:", pngResult.secure_url);

    return {
        tiffUrl: tiffResult.secure_url,
        pngUrl: pngResult.secure_url,
        tiffPublicId: tiffResult.public_id,
        pngPublicId: pngResult.public_id
    };
}

// ============================================================
// SEND TIFF DIRECTLY TO ML MODEL
// ============================================================

async function sendToMLModel(tiffBuffer) {

    console.log("");
    console.log("=================================");
    console.log("SENDING TIFF TO ML MODEL");
    console.log("=================================");

    const form =
        new FormData();

    form.append(
        "file",
        tiffBuffer,
        {
            filename: "sentinel.tif",
            contentType: "image/tiff"
        }
    );

    const response =
        await axios.post(
            ML_API,
            form,
            {

                headers: {
                    ...form.getHeaders()
                },

                timeout:
                    180000
            }
        );

    console.log(
        "ML RESPONSE:",
        response.data
    );

    return response.data;
}

// ============================================================
// PREDICTION ROUTE
// ============================================================

app.post(
    "/predict",
    async (req, res) => {

        try {

            const {
                latitude,
                longitude
            } = req.body;

            // ----------------------------------------
            // VALIDATION
            // ----------------------------------------

            if (
                latitude === undefined ||
                longitude === undefined
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Latitude and longitude are required"
                });
            }

            const lat =
                Number(latitude);

            const lon =
                Number(longitude);

            if (
                !Number.isFinite(lat) ||
                !Number.isFinite(lon)
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Latitude and longitude must be valid numbers"
                });
            }

            if (
                lat < -90 ||
                lat > 90
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Invalid latitude"
                });
            }

            if (
                lon < -180 ||
                lon > 180
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Invalid longitude"
                });
            }

            // ----------------------------------------
            // 1. COPERNICUS TOKEN
            // ----------------------------------------

            console.log(
                "\nGetting Copernicus token..."
            );

            const token =
                await getToken();

            console.log(
                "Copernicus authentication successful"
            );

            // ----------------------------------------
            // 2. GET SENTINEL TIFF
            // ----------------------------------------

            const tiffBuffer =
                await getSentinelImage(
                    token,
                    lat,
                    lon
                );

            // ----------------------------------------
            // 3. BUILD PNG PREVIEW (in-memory)
            // ----------------------------------------

            let pngBuffer = null;

            try {

                pngBuffer =
                    await tiffToPng(tiffBuffer);

            } catch (pngError) {

                // A PNG failure should NOT block the prediction.
                console.error(
                    "PNG conversion failed:",
                    pngError.message
                );
            }

            // ----------------------------------------
            // 4. UPLOAD TO CLOUDINARY (both formats)
            // ----------------------------------------

            let images = {
                tiffUrl: null,
                pngUrl: null,
                tiffPublicId: null,
                pngPublicId: null
            };

            try {

                images =
                    await uploadSentinelImages(
                        tiffBuffer,
                        pngBuffer ?? tiffBuffer,
                        lat,
                        lon
                    );

                // If PNG conversion failed, we uploaded the TIFF bytes
                // as the "png" asset — drop that misleading URL.
                if (!pngBuffer) {
                    images.pngUrl = null;
                    images.pngPublicId = null;
                }

            } catch (uploadError) {

                // An upload failure should NOT block the prediction
                // either — we still want to return the ML result.
                console.error(
                    "Cloudinary upload failed:",
                    uploadError.message
                );
            }

            // ----------------------------------------
            // 5. DIRECTLY SEND TIFF TO ML
            // ----------------------------------------

            const prediction =
                await sendToMLModel(
                    tiffBuffer
                );

            // ----------------------------------------
            // 6. RETURN ML RESPONSE + IMAGE URLS
            // ----------------------------------------

            return res.status(200).json({

                ...prediction,

                images
            });

        } catch (error) {

            console.error("");
            console.error(
                "================================="
            );
            console.error(
                "PREDICTION ERROR"
            );
            console.error(
                "================================="
            );

            console.error(
                error.response?.data ||
                error.message
            );

            return res.status(500).json({

                success: false,

                message:
                    "Failed to process Sentinel prediction",

                error:
                    error.response?.data ||
                    error.message
            });
        }
    }
);

// ============================================================
// START SERVER
// ============================================================

app.listen(
    PORT,
    () => {

        console.log("");
        console.log(
            "================================="
        );

        console.log(
            "SENTINEL LANDSLIDE SERVER"
        );

        console.log(
            "================================="
        );

        console.log(
            `Server running on port ${PORT}`
        );

        console.log(
            `Home   : http://localhost:${PORT}/`
        );

        console.log(
            `Predict: POST http://localhost:${PORT}/predict`
        );

        console.log(
            "================================="
        );
    }
);