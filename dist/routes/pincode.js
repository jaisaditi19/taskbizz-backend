"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// server/src/routes/pincode.ts
const express_1 = __importDefault(require("express"));
const axios_1 = __importDefault(require("axios"));
const https_1 = __importDefault(require("https"));
const http_1 = __importDefault(require("http"));
const router = express_1.default.Router();
// Multiple API endpoints to try - in order of preference
const PINCODE_APIS = [
    {
        name: "IndianPincodes",
        url: (pincode) => `https://www.indianpincodes.co.in/api/pincode/${pincode}`,
        transform: (data, pincode) => {
            if (data.status === "success" && data.data) {
                return [
                    {
                        Status: "Success",
                        PostOffice: [
                            {
                                Name: data.data.area || "Unknown",
                                Pincode: pincode,
                                BranchType: "Post Office",
                                DeliveryStatus: "Delivery",
                                District: data.data.district || "Unknown",
                                State: data.data.state || "Unknown",
                                Country: "India",
                                Block: "",
                                Circle: data.data.state || "",
                                Division: "",
                                Region: "",
                            },
                        ],
                    },
                ];
            }
            return null;
        },
    },
    {
        name: "PostalPinCode_HTTP",
        url: (pincode) => `http://api.postalpincode.in/pincode/${pincode}`,
        transform: (data) => data, // Already in correct format
    },
    {
        name: "PostalPinCode_HTTPS",
        url: (pincode) => `https://api.postalpincode.in/pincode/${pincode}`,
        transform: (data) => data, // Already in correct format
    },
    {
        name: "Zippopotamus",
        url: (pincode) => `https://api.zippopotam.us/in/${pincode}`,
        transform: (data, pincode) => {
            if (data && data.places && data.places.length > 0) {
                return [
                    {
                        Status: "Success",
                        PostOffice: [
                            {
                                Name: data.places[0]["place name"] || "Unknown",
                                Pincode: pincode,
                                BranchType: "Post Office",
                                DeliveryStatus: "Delivery",
                                District: data.places[0]["state"] || "Unknown",
                                State: data.places[0]["state"] || "Unknown",
                                Country: "India",
                                Block: "",
                                Circle: "",
                                Division: "",
                                Region: "",
                            },
                        ],
                    },
                ];
            }
            return null;
        },
    },
];
// Custom function to make HTTP request without axios
function makeHttpRequest(url, timeout = 10000) {
    return new Promise((resolve, reject) => {
        const isHttps = url.startsWith("https");
        const httpModule = isHttps ? https_1.default : http_1.default;
        const options = {
            timeout,
            headers: {
                "User-Agent": "Mozilla/5.0 (compatible; taskbizz-backend/1.0)",
                Accept: "application/json",
                Connection: "close",
            },
        };
        if (isHttps) {
            options.rejectUnauthorized = false;
            options.secureProtocol = "TLSv1_2_method";
        }
        const req = httpModule.get(url, options, (res) => {
            let data = "";
            res.on("data", (chunk) => {
                data += chunk;
            });
            res.on("end", () => {
                try {
                    const jsonData = JSON.parse(data);
                    resolve({ data: jsonData, status: res.statusCode });
                }
                catch (e) {
                    resolve({ data: data, status: res.statusCode });
                }
            });
        });
        req.on("error", (err) => {
            reject(err);
        });
        req.on("timeout", () => {
            req.destroy();
            reject(new Error("Request timeout"));
        });
        req.setTimeout(timeout);
    });
}
// Enhanced function to try multiple APIs
async function fetchPincodeData(pincode) {
    const errors = [];
    for (const api of PINCODE_APIS) {
        try {
            console.log(`Trying ${api.name} API...`);
            const url = api.url(pincode);
            let result;
            // Try native HTTP/HTTPS request first
            try {
                result = await makeHttpRequest(url, 8000);
            }
            catch (nativeError) {
                // Fallback to axios for HTTPS APIs
                if (url.startsWith("https")) {
                    const response = await axios_1.default.get(url, {
                        httpsAgent: new https_1.default.Agent({
                            rejectUnauthorized: false,
                        }),
                        timeout: 8000,
                        headers: {
                            "User-Agent": "Mozilla/5.0 (compatible; taskbizz-backend/1.0)",
                            Accept: "application/json",
                        },
                    });
                    result = { data: response.data, status: response.status };
                }
                else {
                    throw nativeError;
                }
            }
            if (result.status === 200 && result.data) {
                const transformedData = api.transform(result.data, pincode);
                if (transformedData) {
                    console.log(`${api.name} API succeeded`);
                    return transformedData;
                }
            }
            console.log(`${api.name} API returned empty/invalid data`);
            errors.push({
                method: api.name,
                error: `Invalid response: status ${result.status}`,
                data: result.data,
            });
        }
        catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            console.log(`${api.name} API failed:`, errorMessage);
            errors.push({ method: api.name, error: errorMessage });
        }
    }
    // Try API Setu (Government of India) as last resort
    try {
        console.log("Trying API Setu (Government API)...");
        // Note: API Setu requires registration at https://apisetu.gov.in/
        // For now, we'll try the public endpoint structure
        const govUrl = `https://apisetu.gov.in/api/v1/pincode/${pincode}`;
        const result = await makeHttpRequest(govUrl, 8000);
        if (result.status === 200 && result.data) {
            console.log("API Setu succeeded");
            // Transform response if needed
            return result.data;
        }
        console.log("API Setu requires authentication - skipping");
    }
    catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.log("API Setu failed:", errorMessage);
        errors.push({ method: "api-setu", error: errorMessage });
    }
    throw new Error(`All pincode lookup strategies failed: ${JSON.stringify(errors, null, 2)}`);
}
// Main pincode route
router.get("/:pincode", async (req, res) => {
    const { pincode } = req.params;
    if (!/^\d{6}$/.test(pincode)) {
        return res
            .status(400)
            .json({ error: "Invalid pincode format. Must be 6 digits." });
    }
    try {
        const data = await fetchPincodeData(pincode);
        return res.json(data);
    }
    catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error("All pincode strategies failed:", errorMessage);
        // Return structured error response
        return res.status(503).json({
            error: "Unable to fetch pincode data from external APIs",
            pincode: pincode,
            details: errorMessage,
            suggestions: [
                "Check if the pincode is correct and exists",
                "Try again after a few minutes",
                "Contact support if the issue persists",
            ],
            // Minimal mock data for development
            fallback: {
                Status: "Error",
                Message: "All external APIs are currently unavailable",
                PostOffice: [
                    {
                        Name: "Unknown",
                        Pincode: pincode,
                        District: "Unknown",
                        State: "Unknown",
                        Country: "India",
                    },
                ],
            },
        });
    }
});
// Test individual APIs
router.get("/test/:pincode", async (req, res) => {
    const { pincode } = req.params;
    const results = {};
    if (!/^\d{6}$/.test(pincode)) {
        return res.status(400).json({ error: "Invalid pincode format" });
    }
    for (const api of PINCODE_APIS) {
        try {
            const start = Date.now();
            const url = api.url(pincode);
            const result = await makeHttpRequest(url, 5000);
            const duration = Date.now() - start;
            results[api.name] = {
                success: result.status === 200,
                status: result.status,
                duration: `${duration}ms`,
                hasData: !!result.data,
                url: url,
                sampleData: result.data
                    ? JSON.stringify(result.data).substring(0, 200) + "..."
                    : null,
            };
        }
        catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            results[api.name] = {
                success: false,
                error: errorMessage,
                url: api.url(pincode),
            };
        }
    }
    return res.json({
        pincode,
        timestamp: new Date().toISOString(),
        results,
        recommendation: Object.entries(results)
            .filter(([_, result]) => result.success)
            .map(([name]) => name)
            .join(", ") || "None working currently",
    });
});
// Quick health check
router.get("/health", (req, res) => {
    res.json({
        status: "OK",
        service: "Pincode API Router",
        availableEndpoints: [
            "GET /:pincode - Get pincode details",
            "GET /test/:pincode - Test all APIs",
            "GET /health - This endpoint",
        ],
        timestamp: new Date().toISOString(),
    });
});
exports.default = router;
