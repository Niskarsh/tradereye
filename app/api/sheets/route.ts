import { NextResponse } from 'next/server';
import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { trades, direction, pnl, type } = body;

    const auth = new JWT({
      email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID!, auth);
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];

    // Initialize Schema with IST labels and raw Seconds for Duration
    if (type === 'INIT_HEADERS') {
      await sheet.setHeaderRow([
        'TradeGroupId', 'Date (IST)', 'Symbol', 'Direction', 'OrderType', 
        'Price', 'Qty', 'GrossPnL', 'NetPnL', 'TotalCharges', 
        'Status', 'Time (IST)', 'Duration (Sec)', 'IsConsistent', 'ExchTradeId'
      ]);
      return NextResponse.json({ success: true });
    }

    const tradeGroupId = `TRD-${Date.now()}`;
    const rows = trades.map((t: any) => ({
      TradeGroupId: tradeGroupId,
      'Date (IST)': t.createTime.split(' ')[0],
      Symbol: t.tradingSymbol,
      Direction: direction,
      OrderType: t.transactionType,
      Price: t.tradedPrice,
      Qty: t.tradedQuantity,
      GrossPnL: pnl.grossPnL.toFixed(2),
      NetPnL: pnl.netPnL.toFixed(2),
      TotalCharges: pnl.totalCharges.toFixed(2),
      Status: pnl.status,
      'Time (IST)': t.createTime.split(' ')[1],
      'Duration (Sec)': pnl.durationSec, // Stored as integer for analytical parsing
      IsConsistent: pnl.isConsistent ? "YES" : "NO",
      ExchTradeId: t.exchangeTradeId
    }));

    await sheet.addRows(rows);
    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}