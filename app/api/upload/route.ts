import { NextResponse } from 'next/server';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3Client = new S3Client({
    region: process.env.AWS_REGION!,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
});

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { fileName, fileType } = body;

        if (!fileName || !fileType) {
            return NextResponse.json({ success: false, error: 'Missing fileName or fileType' }, { status: 400 });
        }

        // Generate a unique key for the file
        const key = `screenshots/${Date.now()}-${fileName}`;

        const command = new PutObjectCommand({
            Bucket: process.env.AWS_S3_BUCKET_NAME!,
            Key: key,
            ContentType: fileType,
        });

        const signedUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 }); // 1 hour

        return NextResponse.json({
            success: true,
            signedUrl,
            key,
            publicUrl: `https://${process.env.AWS_S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`
        });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error('PRE-SIGNED URL ERROR:', message);
        return NextResponse.json({ success: false, error: message }, { status: 500 });
    }
}