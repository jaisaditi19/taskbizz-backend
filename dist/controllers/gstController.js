"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getGstinDetails = void 0;
const gstin_1 = require("../utils/gstin");
const gstinService_1 = require("../services/gstinService");
const getGstinDetails = async (req, res) => {
    try {
        const gstinRaw = String(req.params.gstin || "")
            .toUpperCase()
            .trim();
        if (!(0, gstin_1.isValidGSTIN)(gstinRaw)) {
            return res.status(400).json({ message: "Invalid GSTIN format" });
        }
        if (!process.env.RAPIDAPI_KEY) {
            return res.status(500).json({ message: "GST lookup key not configured" });
        }
        const data = await (0, gstinService_1.fetchGstinDetailsViaJamku)(gstinRaw);
        // Normalize for your UI fields
        const payload = {
            gstin: data.gstin,
            legalName: data.legalName ?? data.tradeName ?? null,
            tradeName: data.tradeName ?? null,
            pan: data.pan ?? (0, gstin_1.panFromGSTIN)(gstinRaw),
            status: data.status ?? null,
            registrationDate: data.registrationDate ?? null,
            address: data.address ?? null,
            pincode: data.pincode ?? null,
            stateName: data.stateName ?? null,
            stateCode: data.stateCode ?? null,
            city: data.city ?? null,
            source: data.source,
        };
        return res.json(payload);
    }
    catch (err) {
        console.error("getGstinDetails error:", err?.response?.data || err);
        return res.status(502).json({ message: "Failed to fetch GSTIN details" });
    }
};
exports.getGstinDetails = getGstinDetails;
