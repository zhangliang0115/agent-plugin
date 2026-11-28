/**
 * Thumbnails and download links for the images/PDFs of one record.
 *
 * Shared by the tool-result viewer (media from the row's `media` field, or from
 * base64 in a loaded old body) and the protocol-frame column. Images share one
 * preview group, so a click opens a large view that pages through all of them.
 */
import { Image, Space } from 'antd';

import { formatBytes, type MediaSet } from '../../lib/payload-view.ts';

export function MediaStrip({ media }: { media: MediaSet }): React.ReactElement | null {
  if (media.images.length === 0 && media.documents.length === 0) return null;
  return (
    <Space size={8} wrap style={{ margin: '6px 0' }}>
      <Image.PreviewGroup>
        {media.images.map((image, index) => (
          <Image
            key={`i${String(index)}`}
            src={image.src}
            alt={`图片 ${String(index + 1)}`}
            title={`${image.mediaType} · ${formatBytes(image.bytes)}`}
            style={{ maxHeight: 180, maxWidth: 320, border: '1px solid var(--border)', borderRadius: 4 }}
          />
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
