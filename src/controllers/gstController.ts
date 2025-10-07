import { Request, Response } from "express";
import { isValidGSTIN, panFromGSTIN } from "../utils/gstin";
import { fetchGstinDetailsViaJamku } from "../services/gstinService";

export const getGstinDetails = async (req: Request, res: Response) => {
  try {
    const gstinRaw = String(req.params.gstin || "")
      .toUpperCase()
      .trim();
    if (!isValidGSTIN(gstinRaw)) {
      return res.status(400).json({ message: "Invalid GSTIN format" });
    }
    if (!process.env.RAPIDAPI_KEY) {
      return res.status(500).json({ message: "GST lookup key not configured" });
    }

    const data = await fetchGstinDetailsViaJamku(gstinRaw);

    // Normalize for your UI fields
    const payload = {
      gstin: data.gstin,
      legalName: data.legalName ?? data.tradeName ?? null,
      tradeName: data.tradeName ?? null,
      pan: data.pan ?? panFromGSTIN(gstinRaw),
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
  } catch (err: any) {
    console.error("getGstinDetails error:", err?.response?.data || err);
    return res.status(502).json({ message: "Failed to fetch GSTIN details" });
  }
};
