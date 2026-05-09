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

    // Headers definition (reused for new sheet creation)
    const headers = [
      'TradeGroupId', 'Date (IST)', 'Symbol', 'Direction', 'OrderType', 
      'Price', 'Qty', 'GrossPnL', 'NetPnL', 'TotalCharges', 
      'Status', 'Time (IST)', 'Duration (Sec)', 'IsConsistent', 'ExchTradeId',
      'Comment',
    ];

    // 1. Determine the target sheet name based on the trade date
    // Assuming trades[0].createTime is "YYYY-MM-DD HH:MM:SS"
    const tradeDate = new Date(trades[0].createTime.replace(/-/g, '/')); 
    const monthNames = ["january", "february", "march", "april", "may", "june",
                        "july", "august", "september", "october", "november", "december"];
    
    const monthName = monthNames[tradeDate.getMonth()];
    const year = tradeDate.getFullYear();
    const targetSheetTitle = `${monthName}-${year}`;

    // 2. Get or Create the sheet
    let sheet = doc.sheetsByTitle[targetSheetTitle];

    if (!sheet) {
      // Create new monthly sheet if it doesn't exist
      sheet = await doc.addSheet({ title: targetSheetTitle });
      await sheet.setHeaderRow(headers);
    }

    // Manual Header Initialization (Legacy support for your INIT_HEADERS type)
    if (type === 'INIT_HEADERS') {
      await sheet.setHeaderRow(headers);
      return NextResponse.json({ success: true, message: `Headers initialized for ${targetSheetTitle}` });
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
      'Duration (Sec)': pnl.durationSec,
      IsConsistent: pnl.isConsistent ? "YES" : "NO",
      ExchTradeId: t.exchangeTradeId,
      Comment: '' 
    }));

    await sheet.addRows(rows);
    return NextResponse.json({ success: true, sheet: targetSheetTitle });
  } catch (error: any) {
    console.error("POST Error:", error.message);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}