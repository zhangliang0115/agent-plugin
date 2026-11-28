/**
 * Thumbnails and download links for the images/PDFs of one record.
 *
 * Shared by the tool-result viewer (media from the row's `media` field, or from
 * base64 in a loaded old body) and the protocol-frame column. Images share one
 * preview group, so a click opens a large view that pages through all of them.
 */
import { Image, Space, Typography } from 'antd';

import { formatBytes, type MediaSet } from '../../lib/payload-view.ts';

const { Text } = Typography;

export function MediaStrip({ media }: { media: MediaSet }): React.ReactElement | null {
  if (media.images.length === 0 && media.documents.length === 0) return null;
  return (
    <Space size={8} wrap style={{ margin: '6px 0' }}>
      <Image.PreviewGroup>
        {media.images.map((image, index) => (
          <div key={`i${String(index)}`} style={{ display: 'inline-block', verticalAlign: 'top' }}>
            <Image
              src={image.src}
              alt={`图片 ${String(index + 1)}`}
              // A tiny image would otherwise render as an unnoticeable dot; pixelated keeps upscaled pixels crisp.
              style={{
                minWidth: 64,
                minHeight: 64,
                maxHeight: 180,
                maxWidth: 320,
                objectFit: 'contain',
                imageRendering: 'pixelated',
                border: '1px solid var(--border)',
                borderRadius: 4,
              }}
            />
            <div>
              <Text type="secondary" style={{ fontSize: 11 }}>
                {`图片 ${String(index + 1)} · ${image.mediaType} · ${formatBytes(image.bytes)}`}
              </Text>
            </div>
          </div>
        ))}
      </Image.PreviewGroup>
      {media.documents.map((doc, index) => {
        const pdf = doc.mediaType === undefined;
        return (
          <a key={`d${String(index)}`} href={doc.href} download={pdf ? `document-${String(index + 1)}.pdf` : `file-${String(index + 1)}`}>
            {`${pdf ? 'PDF' : doc.mediaType} ${String(index + 1)}（${formatBytes(doc.bytes)}）`}
          </a>
        );
      })}
    </Space>
  );
}
