"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchGstinDetailsViaJamku = fetchGstinDetailsViaJamku;
const axios_1 = __importDefault(require("axios"));
async function fetchGstinDetailsViaJamku(gstin) {
    const url = `https://gst-return-status.p.rapidapi.com/free/gstin/${encodeURIComponent(gstin)}`;
    const resp = await axios_1.default.get(url, {
        headers: {
            "x-rapidapi-key": process.env.RAPIDAPI_KEY,
            "x-rapidapi-host": "gst-return-status.p.rapidapi.com",
        },
        timeout: 8000,
    });
    const d = resp?.data?.data ?? {};
    // Jamku fields (commonly): lgnm (legal), tradeName, pan, sts, rgdt, adr, pincode, stateName/stateCode, city
    return {
        gstin,
        legalName: d.lgnm ?? d.legalName ?? null,
        tradeName: d.tradeName ?? null,
        pan: d.pan ?? null,
        status: d.sts ?? null,
        registrationDate: d.rgdt ?? null,
        address: d.adr ?? null,
        pincode: d.pincode ?? null,
        stateName: d.stateName ?? null,
        stateCode: d.stateCode ?? null,
        city: d.city ?? null,
        source: "jamku-rapidapi",
    };
}
