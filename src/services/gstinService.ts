import axios from "axios";

export type GstinLookup = {
  gstin: string;
  legalName?: string | null;
  tradeName?: string | null;
  pan?: string | null;
  status?: string | null;
  registrationDate?: string | null; // dd/mm/yyyy
  address?: string | null;
  pincode?: string | null;
  stateName?: string | null;
  stateCode?: string | null;
  city?: string | null;
  source: string;
};

export async function fetchGstinDetailsViaJamku(
  gstin: string
): Promise<GstinLookup> {
  const url = `https://gst-return-status.p.rapidapi.com/free/gstin/${encodeURIComponent(
    gstin
  )}`;
  const resp = await axios.get(url, {
    headers: {
      "x-rapidapi-key": process.env.RAPIDAPI_KEY!,
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
