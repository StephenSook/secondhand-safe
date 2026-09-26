import json

from harvest import append_unique, ebay_image, normalize_craigslist, normalize_ebay, redact


def test_redact_removes_contact_details():
    s = redact("Call 404-555-0123 or (770) 555 0199, email mom.seller+x@gmail.com. Pickup Midtown.")
    assert "555" not in s and "@" not in s
    assert "Pickup Midtown." in s
    assert redact("Crib 28x52 inches, $120") == "Crib 28x52 inches, $120"   # sizes and prices survive


def test_craigslist_drops_seller_contact_and_rounds_location():
    row = {"postId": "7812", "url": "https://atlanta.craigslist.org/x/7812.html", "title": "Bassinet",
           "description": "text me 404 555 0123", "location": "Marietta Call 770-555-0142", "priceUsd": 40, "latitude": 33.77612, "longitude": -84.39631,
           "emails": ["a@b.com"], "phoneNumbers": ["4045550123"], "imageUrls": ["https://images.craigslist.org/a.jpg"]}
    n = normalize_craigslist(row)
    assert n["lat"] == 33.78 and n["lng"] == -84.4
    assert "555" not in n["description"] and "555" not in n["location"]
    assert "emails" not in n and "phoneNumbers" not in n and "a@b.com" not in json.dumps(n)


def test_ebay_upgrades_thumbnail_and_strips_tracking():
    assert ebay_image("https://i.ebayimg.com/images/g/abc/s-l140.webp") == "https://i.ebayimg.com/images/g/abc/s-l500.webp"
    n = normalize_ebay({"item_id": "1", "product_url": "https://www.ebay.com/itm/1?hash=x", "product_title": "Rock n Play",
                        "price": "$1,049.99", "image_url": "https://i.ebayimg.com/g/s-l225.jpg"})
    assert n["url"] == "https://www.ebay.com/itm/1" and n["priceUsd"] == 1049.99


def test_append_unique_dedupes_and_skips_rows_without_photos(tmp_path):
    p = tmp_path / "l.jsonl"
    rows = [{"id": "a", "url": "u", "images": ["i"]}, {"id": "a", "url": "u", "images": ["i"]},
            {"id": "b", "url": "u", "images": []}]
    assert append_unique(str(p), rows) == (1, 1)
    assert append_unique(str(p), rows) == (0, 1)
