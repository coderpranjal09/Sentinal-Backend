require("dotenv").config();

const express = require("express");
const axios = require("axios");
const FormData = require("form-data");
const cors = require("cors");
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
            // 3. DIRECTLY SEND TIFF TO ML
            // ----------------------------------------

            const prediction =
                await sendToMLModel(
                    tiffBuffer
                );

            // ----------------------------------------
            // 4. RETURN ML RESPONSE
            // ----------------------------------------

            return res.status(200).json(
                prediction
            );

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