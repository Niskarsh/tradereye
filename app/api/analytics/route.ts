import { NextResponse } from 'next/server';
import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';

export async function GET() {
  try {
    const auth = new JWT({
      email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID!, auth);
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();

    // Mapping ALL columns required for the dashboard logic
    const data = rows.map(row => ({
      TradeGroupId: row.get('TradeGroupId'),
      date: row.get('Date (IST)'),
      Symbol: row.get('Symbol'),
      GrossPnL: row.get('GrossPnL'),
      NetPnL: row.get('NetPnL'),
      TotalCharges: row.get('TotalCharges'),
      Status: row.get('Status')
    }));

    return NextResponse.json(data);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}