// Handler for get_company_info tool

import QuickBooks from "node-quickbooks";
import { promisify, getCompanyIdValue } from "../../client/index.js";
import { outputReport } from "../../utils/index.js";
import { formatAddress, type QBAddress } from "./customer.js";

// Only the fields the summary reads; QBO omits a key when it is unset, so all
// are optional. The full object passes through to outputReport untyped.
interface CompanyInfo {
  CompanyName?: string;
  LegalName?: string;
  Country?: string;
  FiscalYearStartMonth?: string;
  CompanyStartDate?: string;
  Email?: { Address?: string };
  PrimaryPhone?: { FreeFormNumber?: string };
  WebAddr?: { URI?: string };
  CompanyAddr?: QBAddress;
}

/** Render a short identity card, skipping every absent field. Pure; safe on any shape. */
export function formatCompanyInfoSummary(info: CompanyInfo): string {
  const fields: Array<[string, string | undefined]> = [
    ["Name", info?.CompanyName],
    // Legal name only adds information when it differs from the trading name.
    ["Legal name", info?.LegalName !== info?.CompanyName ? info?.LegalName : undefined],
    ["Country", info?.Country],
    ["Fiscal year starts", info?.FiscalYearStartMonth],
    ["Company start date", info?.CompanyStartDate],
    ["Email", info?.Email?.Address],
    ["Phone", info?.PrimaryPhone?.FreeFormNumber],
    ["Web", info?.WebAddr?.URI],
  ];

  return [
    "Company Info",
    "============",
    ...fields.filter(([, value]) => value).map(([label, value]) => `${label}: ${value}`),
    ...(info?.CompanyAddr ? formatAddress(info.CompanyAddr, "Address") : []),
  ].join("\n");
}

export async function handleGetCompanyInfo(
  client: QuickBooks
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const companyId = getCompanyIdValue();
  const info = (await promisify<unknown>((cb) =>
    client.getCompanyInfo(companyId!, cb)
  )) as CompanyInfo;
  return outputReport("company-info", info, formatCompanyInfoSummary(info));
}
