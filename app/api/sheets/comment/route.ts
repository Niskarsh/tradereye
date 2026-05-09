import { NextResponse } from 'next/server';
import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { sheetTitle, exchTradeId, comment } = body;

        if (!sheetTitle || !exchTradeId || typeof comment !== 'string') {
            return NextResponse.json({ success: false, error: 'Missing required fields' }, { status: 400 });
        }

        const auth = new JWT({
            email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
            key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });

        const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID!, auth);
        await doc.loadInfo();

        const sheet = doc.sheetsByTitle[sheetTitle];
        if (!sheet) {
            return NextResponse.json({ success: false, error: `Sheet ${sheetTitle} not found` }, { status: 404 });
        }

        const rows = await sheet.getRows();
        const row = rows.find(r => r.get('ExchTradeId') === exchTradeId) as unknown as { Comment: string; save: () => Promise<void> } | undefined;

        if (!row) {
            return NextResponse.json({ success: false, error: 'Row not found for provided ExchTradeId' }, { status: 404 });
        }

        // row.Comment = comment;
        // Use .set to ensure the library tracks the change
        row.set('Comment', comment);
        console.log(`Updating comment for ExchTradeId ${exchTradeId} in sheet ${sheetTitle}: ${comment}`);
        await row.save();

        return NextResponse.json({ success: true });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error('COMMENT UPDATE ERROR:', message);
        return NextResponse.json({ success: false, error: message }, { status: 500 });
    }
}
