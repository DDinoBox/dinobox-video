import sys
from pathlib import Path

from pypdf import PdfReader


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: extract_pdf_text.py <pdf-path>")

    pdf_path = Path(sys.argv[1]).resolve()
    reader = PdfReader(str(pdf_path))
    if reader.is_encrypted:
        try:
            reader.decrypt("")
        except Exception as exc:
            raise RuntimeError("encrypted PDF cannot be read") from exc

    pages = []
    for index, page in enumerate(reader.pages[:80], start=1):
        text = (page.extract_text() or "").strip()
        if text:
            pages.append(f"[Page {index}]\n{text}")
    sys.stdout.write("\n\n".join(pages))


if __name__ == "__main__":
    main()
