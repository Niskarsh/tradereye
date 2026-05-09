import { NextResponse } from 'next/server';
import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { sheetTitle, exchTradeId, comment, screenshotUrl } = body;

        // FIX: Remove 'typeof comment !== "string"' from the required check
        if (!sheetTitle || !exchTradeId) {
            return NextResponse.json({ success: false, error: 'Missing sheetTitle or exchTradeId' }, { status: 400 });
        }

        const auth = new JWT({
            email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
            key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });

        const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID!, auth);
        await doc.loadInfo();

        const sheet = doc.sheetsByTitle[sheetTitle];
        if (!sheet) return NextResponse.json({ success: false, error: `Sheet ${sheetTitle} not found` }, { status: 404 });

        const rows = await sheet.getRows();
        const row = rows.find(r => r.get('ExchTradeId') === exchTradeId);

        if (!row) return NextResponse.json({ success: false, error: 'Row not found' }, { status: 404 });

        // Update Comment ONLY if it was provided
        if (typeof comment === 'string') {
            row.set('Comment', comment);
        }

        // Update Screenshot ONLY if it was provided
        if (screenshotUrl) {
            row.set('ScreenshotUrl', screenshotUrl);
        }

        console.log(`Syncing Row ${exchTradeId}: Comment updated? ${!!comment}, Screenshot updated? ${!!screenshotUrl}`);
        await row.save();

        return NextResponse.json({ success: true });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return NextResponse.json({ success: false, error: message }, { status: 500 });
    }
}