import { NextResponse } from 'next/server';
import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { sheetTitle, exchTradeId, comment, screenshotUrl, date, key, setup, tradeGroupId } = body;

        const auth = new JWT({
            email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
            key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });

        const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID!, auth);
        await doc.loadInfo();

        const sheet = doc.sheetsByTitle[sheetTitle];
        if (!sheet) return NextResponse.json({ success: false, error: `Sheet ${sheetTitle} not found` }, { status: 404 });

        // Setup tag (momentum / reversal / blank) for a whole trade group
        if (typeof setup === 'string' && tradeGroupId) {
            if (!['', 'momentum', 'reversal'].includes(setup)) {
                return NextResponse.json({ success: false, error: 'Setup must be momentum, reversal or empty' }, { status: 400 });
            }
            if (!sheet.headerValues.includes('Setup')) {
                return NextResponse.json({ success: false, error: 'This month tab has no Setup column yet. Run Live or Backfill once to add it.' }, { status: 409 });
            }
            const groupRows = (await sheet.getRows()).filter(r => r.get('TradeGroupId') === tradeGroupId);
            if (groupRows.length === 0) return NextResponse.json({ success: false, error: 'Trade not found' }, { status: 404 });
            for (const r of groupRows) { r.set('Setup', setup); await r.save(); }
            return NextResponse.json({ success: true, updated: groupRows.length });
        }

        const rows = await sheet.getRows();

        // Handle Daily Live PnL Chart Upload
        if (key === 'live-pnl') {
            if (!date) {
                return NextResponse.json({ success: false, error: 'Missing date for live-pnl upload' }, { status: 400 });
            }
            // Find the first row matching this date to store the daily live PnL URL reference
            const row = rows.find(r => r.get('Date (IST)') === date);
            if (!row) {
                return NextResponse.json({ success: false, error: `No trade rows found for date ${date}` }, { status: 404 });
            }

            row.set('LivePnlUrl', screenshotUrl);
            await row.save();
            console.log(`Syncing Daily Live PnL for ${date}: Updated successfully`);
            return NextResponse.json({ success: true });
        }

        // Handle Per-Trade Comments & Screenshots
        if (!sheetTitle || !exchTradeId) {
            return NextResponse.json({ success: false, error: 'Missing sheetTitle or exchTradeId' }, { status: 400 });
        }

        const row = rows.find(r => r.get('ExchTradeId') === exchTradeId);
        if (!row) return NextResponse.json({ success: false, error: 'Row not found' }, { status: 404 });

        if (typeof comment === 'string') {
            row.set('Comment', comment);
        }

        if (screenshotUrl) {
            row.set('ScreenshotUrl', screenshotUrl);
        }

        await row.save();
        return NextResponse.json({ success: true });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return NextResponse.json({ success: false, error: message }, { status: 500 });
    }
}