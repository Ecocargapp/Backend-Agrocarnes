#!/usr/bin/env bash
# Genera docs/Documentacion-Agrocarnes.pdf a partir de los .md de docs/ y CHANGELOG.md.
# Requiere pandoc y wkhtmltopdf (o un navegador Chromium como alternativa).
#   bash docs/generar-pdf.sh
set -euo pipefail
cd "$(dirname "$0")/.."

SALIDA=docs/Documentacion-Agrocarnes.pdf
FECHA=$(date +%Y-%m-%d)
VERSION=$(git log -1 --format='%h · %ad' --date=short 2>/dev/null || echo "sin git")
TMP=$(mktemp -d)

# Portada + documentos en orden.
cat > "$TMP/00-portada.md" <<EOF
---
title: "Agrocarnes — Documentación del sistema"
subtitle: "Inventario, compras, producción, ventas y facturación electrónica"
date: "Generado el $FECHA · versión del código: $VERSION"
lang: es
---

<div style="page-break-after: always"></div>
EOF

# Quita los enlaces relativos entre documentos (no aplican en el PDF) y arma un solo archivo.
{
  cat "$TMP/00-portada.md"
  for f in docs/01-*.md docs/02-*.md docs/03-*.md docs/04-*.md docs/05-*.md docs/06-*.md docs/07-*.md CHANGELOG.md; do
    echo; echo '<div style="page-break-after: always"></div>'; echo
    sed -E 's/\]\(([0-9]{2}-[a-z-]+\.md|\.\.\/CHANGELOG\.md)\)/]/g' "$f"
  done
} > "$TMP/todo.md"

cat > "$TMP/estilo.css" <<'EOF'
body { font-family: "Helvetica Neue", Arial, sans-serif; font-size: 11pt; line-height: 1.45; color: #1c1a17; max-width: 100%; }
h1 { color: #b3401f; font-size: 20pt; border-bottom: 2px solid #b3401f; padding-bottom: 4px; margin-top: 0; }
h2 { font-size: 14pt; margin-top: 22px; color: #1c1a17; }
h3 { font-size: 12pt; }
table { border-collapse: collapse; width: 100%; margin: 10px 0; font-size: 9.5pt; page-break-inside: avoid; }
th, td { border: 1px solid #ccc; padding: 5px 7px; text-align: left; vertical-align: top; }
th { background: #f6e6df; }
code { font-family: Menlo, Consolas, monospace; font-size: 9pt; background: #f4f1ee; padding: 1px 3px; }
pre { background: #f4f1ee; padding: 10px; font-size: 8.5pt; white-space: pre-wrap; border-radius: 4px; }
.title { font-size: 26pt; color: #b3401f; margin-bottom: 4px; }
.subtitle { font-size: 14pt; color: #555; }
.date { color: #777; }
EOF

pandoc "$TMP/todo.md" -f markdown -t html5 -s --css "$TMP/estilo.css" --metadata title="Agrocarnes — Documentación del sistema" -o "$TMP/todo.html"

if command -v wkhtmltopdf >/dev/null; then
  wkhtmltopdf --quiet --enable-local-file-access --page-size Letter --margin-top 18mm --margin-bottom 18mm --margin-left 16mm --margin-right 16mm \
    "$TMP/todo.html" "$SALIDA" 2>/dev/null
else
  CHROME=$(command -v chromium || command -v chromium-browser || command -v google-chrome || true)
  [ -n "$CHROME" ] || { echo "Instala wkhtmltopdf o Chromium para generar el PDF"; exit 1; }
  "$CHROME" --headless --disable-gpu --no-sandbox --print-to-pdf="$SALIDA" "file://$TMP/todo.html" 2>/dev/null
fi
rm -rf "$TMP"
echo "PDF generado: $SALIDA"
