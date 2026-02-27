// Netlify Serverless Function: CMS Medicare Data Proxy
// Bypasses browser CORS restrictions on data.cms.gov
// Enhanced: If an org (Type 2) NPI has no direct CMS data,
// looks up individual providers via NPPES and aggregates their CMS billing.
// Deploy: netlify/functions/cms-lookup.js

const DATASETS = {
  aggregate: '8889d81e-2ee7-448f-8713-f071038289b5',  // By Provider
  byService: '92396110-2aed-4d63-a6a2-5d6207d46a29'   // By Provider & Service (HCPCS)
};

const VBC_CODES = ['99490','99491','99453','99454','99457','99458','G0438','G0439','99495','99496','99484'];
const CODE_NAMES = {
  '99490':'CCM','99491':'CCM Complex','99453':'RPM Setup','99454':'RPM Device',
  '99457':'RPM Mgmt','99458':'RPM Addl','G0438':'AWV Initial','G0439':'AWV Subsequent',
  '99495':'TCM 14-day','99496':'TCM 7-day','99484':'BHI'
};

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
  'Cache-Control': 'public, max-age=86400'
};

// ── Fetch CMS data for a single NPI ──────────────────────────────────
async function fetchCMSForNPI(npi) {
  const [aggRes, svcRes] = await Promise.all([
    fetch(`https://data.cms.gov/data-api/v1/dataset/${DATASETS.aggregate}/data?filter[Rndrng_NPI]=${npi}&size=1`),
    fetch(`https://data.cms.gov/data-api/v1/dataset/${DATASETS.byService}/data?filter[Rndrng_NPI]=${npi}&size=500`)
  ]);

  const agg = aggRes.ok ? await aggRes.json() : [];
  const svc = svcRes.ok ? await svcRes.json() : [];

  if (!agg.length && !svc.length) return null;

  const d = agg.length ? agg[0] : {};
  const result = {
    total_medicare_payment: parseFloat(d.Tot_Mdcr_Plymt_Amt || d.tot_mdcr_plymt_amt || 0),
    total_beneficiaries: parseInt(d.Tot_Benes || d.tot_benes || 0),
    total_services: parseInt(d.Tot_Srvcs || d.tot_srvcs || 0),
    name: d.Rndrng_Prvdr_Last_Org_Name || d.rndrng_prvdr_last_org_name || '',
    first_name: d.Rndrng_Prvdr_First_Name || d.rndrng_prvdr_first_name || '',
    specialty: d.Rndrng_Prvdr_Type || d.rndrng_prvdr_type || '',
    city: d.Rndrng_Prvdr_City || d.rndrng_prvdr_city || '',
    state: d.Rndrng_Prvdr_State_Abrvtn || d.rndrng_prvdr_state_abrvtn || '',
    entity_type: d.Rndrng_Prvdr_Ent_Cd || d.rndrng_prvdr_ent_cd || '',
    hcpcs: {}
  };

  VBC_CODES.forEach(code => {
    result.hcpcs[code] = { name: CODE_NAMES[code], services: 0, beneficiaries: 0, payment: 0 };
  });

  if (svc.length) {
    svc.forEach(row => {
      const code = row.HCPCS_Cd || row.hcpcs_cd || '';
      if (result.hcpcs[code]) {
        const avgPay = parseFloat(row.Avg_Mdcr_Pymt_Amt || row.avg_mdcr_pymt_amt || 0);
        const services = parseInt(row.Tot_Srvcs || row.tot_srvcs || 0);
        const benes = parseInt(row.Tot_Benes || row.tot_benes || 0);
        result.hcpcs[code].services += services;
        result.hcpcs[code].beneficiaries += benes;
        result.hcpcs[code].payment += Math.round(avgPay * services);
      }
    });
  }

  return result;
}

// ── Look up org members via NPPES ────────────────────────────────────
// When an org NPI has no direct CMS data, we find individual providers
// associated with the org by searching NPPES by organization name + location.
async function findOrgMembers(orgNPI) {
  // Step 1: Get the org's info from NPPES
  const orgRes = await fetch(
    `https://npiregistry.cms.hhs.gov/api/?version=2.1&number=${orgNPI}`
  );
  if (!orgRes.ok) return { members: [], orgName: '', orgCity: '', orgState: '' };
  const orgData = await orgRes.json();
  if (!orgData.results || !orgData.results.length) return { members: [], orgName: '', orgCity: '', orgState: '' };

  const org = orgData.results[0];
  if (org.enumeration_type !== 'NPI-2') return { members: [], orgName: '', orgCity: '', orgState: '' };

  const orgName = org.basic?.organization_name || '';
  if (!orgName) return { members: [], orgName: '', orgCity: '', orgState: '' };

  const orgAddr = org.addresses?.[0] || {};
  const orgState = orgAddr.state || '';
  const orgCity = orgAddr.city || '';

  // Step 2: Search NPPES for individual providers matching this org name
  // The NPPES API "organization_name" filter on NPI-1 searches find individuals
  // whose practice is associated with the given org name.
  const searchParams = new URLSearchParams({
    version: '2.1',
    organization_name: orgName,
    enumeration_type: 'NPI-1',
    limit: '200'
  });
  if (orgState) searchParams.set('state', orgState);

  let members = [];
  const searchRes = await fetch(
    `https://npiregistry.cms.hhs.gov/api/?${searchParams.toString()}`
  );

  if (searchRes.ok) {
    const searchData = await searchRes.json();
    if (searchData.results && searchData.results.length) {
      members = searchData.results
        .filter(p => p.enumeration_type === 'NPI-1')
        .map(p => p.number);
    }
  }

  // If state-filtered search returned nothing, try without state
  if (!members.length && orgState) {
    searchParams.delete('state');
    const fallbackRes = await fetch(
      `https://npiregistry.cms.hhs.gov/api/?${searchParams.toString()}`
    );
    if (fallbackRes.ok) {
      const fallbackData = await fallbackRes.json();
      if (fallbackData.results) {
        members = fallbackData.results
          .filter(p => p.enumeration_type === 'NPI-1')
          .map(p => p.number);
      }
    }
  }

  // Cap at 50 to stay within Netlify function timeout (~10s)
  return {
    members: members.slice(0, 50),
    orgName,
    orgCity,
    orgState
  };
}

// ── Aggregate multiple provider results into one org result ──────────
function aggregateResults(orgNPI, memberResults, orgName) {
  const combined = {
    npi: orgNPI,
    year: 2023,
    is_org: true,
    is_aggregated: true,
    member_count: memberResults.length,
    member_npis: memberResults.map(m => m.npi),
    org_name: orgName,
    total_medicare_payment: 0,
    total_beneficiaries: 0,
    total_services: 0,
    note: `Organizational aggregate across ${memberResults.length} rendering providers found via NPPES`,
    hcpcs: {}
  };

  VBC_CODES.forEach(code => {
    combined.hcpcs[code] = { name: CODE_NAMES[code], services: 0, beneficiaries: 0, payment: 0 };
  });

  memberResults.forEach(m => {
    combined.total_medicare_payment += m.data.total_medicare_payment || 0;
    combined.total_beneficiaries += m.data.total_beneficiaries || 0;
    combined.total_services += m.data.total_services || 0;

    VBC_CODES.forEach(code => {
      if (m.data.hcpcs?.[code]) {
        combined.hcpcs[code].services += m.data.hcpcs[code].services;
        combined.hcpcs[code].beneficiaries += m.data.hcpcs[code].beneficiaries;
        combined.hcpcs[code].payment += m.data.hcpcs[code].payment;
      }
    });
  });

  return combined;
}

// ── Main handler ─────────────────────────────────────────────────────
exports.handler = async (event) => {
  const npi = event.queryStringParameters?.npi;

  if (!npi || !/^\d{10}$/.test(npi)) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid NPI. Must be 10 digits.' }) };
  }

  try {
    // ── Attempt 1: Direct CMS lookup (works for individuals + orgs that bill under org NPI)
    const directResult = await fetchCMSForNPI(npi);

    if (directResult) {
      const response = {
        npi,
        year: 2023,
        total_medicare_payment: directResult.total_medicare_payment,
        total_beneficiaries: directResult.total_beneficiaries,
        total_services: directResult.total_services,
        hcpcs: directResult.hcpcs
      };
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(response) };
    }

    // ── Attempt 2: Org NPI → find members via NPPES → aggregate their CMS data
    const { members: memberNPIs, orgName } = await findOrgMembers(npi);

    if (!memberNPIs.length) {
      return {
        statusCode: 404,
        headers: HEADERS,
        body: JSON.stringify({ error: 'No CMS data found for this NPI', npi })
      };
    }

    // Fetch CMS data for each member (batches of 10 to be kind to CMS API)
    const memberResults = [];
    for (let i = 0; i < memberNPIs.length; i += 10) {
      const batch = memberNPIs.slice(i, i + 10);
      const batchResults = await Promise.all(
        batch.map(async (memberNPI) => {
          const data = await fetchCMSForNPI(memberNPI);
          return data ? { npi: memberNPI, data } : null;
        })
      );
      memberResults.push(...batchResults.filter(Boolean));
    }

    if (!memberResults.length) {
      return {
        statusCode: 404,
        headers: HEADERS,
        body: JSON.stringify({
          error: 'Org NPI identified but no CMS billing data found for member providers',
          npi,
          org_name: orgName,
          members_checked: memberNPIs.length
        })
      };
    }

    const aggregated = aggregateResults(npi, memberResults, orgName);
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify(aggregated) };

  } catch (err) {
    return {
      statusCode: 500,
      headers: HEADERS,
      body: JSON.stringify({ error: 'CMS API request failed', detail: err.message })
    };
  }
};
