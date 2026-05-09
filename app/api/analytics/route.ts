import { NextResponse } from 'next/server';
import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const startParam = searchParams.get('start'); 
  const endParam = searchParams.get('end');     

  const monthNames = [
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december"
  ];

  try {
    const auth = new JWT({
      email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID!, auth);
    await doc.loadInfo();

    // 1. Calculate the current month sheet name (Static)
    const now = new Date();
    const currentMonthSheet = `${monthNames[now.getMonth()]}-${now.getFullYear()}`;

    let targetSheetTitles: string[] = [];

    // 2. Determine which sheets to fetch
    if (!startParam || !endParam) {
      // Default: Only fetch the current month
      targetSheetTitles = [currentMonthSheet];
    } else {
      // Range logic: Get all months between start and end
      const [startMonth, startYear] = startParam.split('-');
      const [endMonth, endYear] = endParam.split('-');

      let currentMonthIdx = monthNames.indexOf(startMonth.toLowerCase());
      let currentYear = parseInt(startYear);
      const endMonthIdx = monthNames.indexOf(endMonth.toLowerCase());
      const endYearValue = parseInt(endYear);

      // Simple guard for invalid month names in params
      if (currentMonthIdx === -1 || endMonthIdx === -1) {
        throw new Error("Invalid month name provided in query parameters.");
      }

      while (currentYear < endYearValue || (currentYear === endYearValue && currentMonthIdx <= endMonthIdx)) {
        targetSheetTitles.push(`${monthNames[currentMonthIdx]}-${currentYear}`);
        
        currentMonthIdx++;
        if (currentMonthIdx > 11) {
          currentMonthIdx = 0;
          currentYear++;
        }
      }
    }

    // 3. Fetch data from all required sheets in parallel
    const tradeData: Record<string, any[]> = {};

    await Promise.all(
      targetSheetTitles.map(async (title) => {
        const sheet = doc.sheetsByTitle[title];
        if (!sheet) {
          tradeData[title] = []; 
          return;
        }

        const rows = await sheet.getRows();
        tradeData[title] = rows.map(row => ({
          TradeGroupId: row.get('TradeGroupId'),
          date: row.get('Date (IST)'),
          Symbol: row.get('Symbol'),
          Direction: row.get('Direction'),
          OrderType: row.get('OrderType'),
          Price: row.get('Price'),
          Qty: row.get('Qty'),
          GrossPnL: row.get('GrossPnL'),
          NetPnL: row.get('NetPnL'),
          TotalCharges: row.get('TotalCharges'),
          Status: row.get('Status'),
          'Time (IST)': row.get('Time (IST)'),
          'Duration (Sec)': row.get('Duration (Sec)'),
          IsConsistent: row.get('IsConsistent'),
          ExchTradeId: row.get('ExchTradeId'),
          Comment: row.get('Comment') || ''
        }));
      })
    );

    // 4. Return combined response
    return NextResponse.json({
      current: currentMonthSheet, // "may-2026"
      data: tradeData             // { "may-2026": [...], "april-2026": [...] }
    });

  } catch (error: any) {
    console.error("GET Error:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}