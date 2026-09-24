#!/usr/bin/env python3
"""
Builds the demo database served by the web inspector: a small, entirely fictional
"field service" app shaped like an OutSystems local storage database (OSSYS_ENTITY map,
OSUSR_* tables, Binary Data stored as base64 text, <Entity>Id references) plus a plain
sync_queue table. Deterministic, no external dependencies.

    python3 web/demo/make-demo-db.py site/demo.db
"""
import base64
import json
import os
import random
import sqlite3
import struct
import sys
import uuid
import zlib
from datetime import datetime, timedelta

random.seed(42)
MODULE = "a1b2c3d4-0000-4000-8000-00000000demo"

FIRST = ["Ana", "Bruno", "Carla", "Diego", "Elisa", "Fábio", "Gabi", "Hugo", "Inês", "João", "Kátia", "Luís", "Marta", "Nuno", "Olga", "Paulo", "Rita", "Sara", "Tiago", "Vera"]
LAST = ["Almeida", "Barros", "Costa", "Duarte", "Esteves", "Ferreira", "Gomes", "Henriques", "Lopes", "Martins", "Nunes", "Pereira", "Rocha", "Silva", "Teixeira", "Vieira"]
CITIES = [("Lisboa", 1), ("Porto", 1), ("Braga", 1), ("Coimbra", 1), ("São Paulo", 2), ("Recife", 2), ("Curitiba", 2), ("Madrid", 3), ("Sevilla", 3), ("London", 4)]
COUNTRIES = [(1, "Portugal", "PT"), (2, "Brazil", "BR"), (3, "Spain", "ES"), (4, "United Kingdom", "GB")]
CATEGORIES = [(1, "Boilers"), (2, "Valves"), (3, "Pumps"), (4, "Sensors"), (5, "Filters")]
PRODUCTS = [
    ("Condensing boiler 24 kW", 1, 1890.0), ("Condensing boiler 32 kW", 1, 2340.0), ("Steam boiler compact", 1, 5120.0),
    ("Ball valve DN25", 2, 38.5), ("Ball valve DN50", 2, 74.9), ("Safety valve 6 bar", 2, 112.0), ("Check valve DN40", 2, 55.0),
    ("Circulation pump 60W", 3, 210.0), ("Booster pump 1.1 kW", 3, 640.0), ("Condensate pump", 3, 185.0),
    ("Pressure sensor 0-10 bar", 4, 96.0), ("Temperature probe PT100", 4, 44.0), ("Flow meter DN32", 4, 399.0),
    ("Y-strainer DN25", 5, 29.9), ("Magnetic filter 1\"", 5, 149.0),
]
STATUSES = ["Draft", "Scheduled", "InProgress", "Completed", "Cancelled"]


def png(width, height, pixel):
    """Minimal RGB PNG encoder; pixel(x, y) -> (r, g, b)."""
    raw = b"".join(b"\x00" + b"".join(bytes(pixel(x, y)) for x in range(width)) for y in range(height))
    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) + \
        chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def product_image(seed, size=160):
    rnd = random.Random(seed)
    a = [rnd.randint(40, 220) for _ in range(3)]
    b = [rnd.randint(40, 220) for _ in range(3)]
    cx, cy, r = size * rnd.uniform(.35, .65), size * rnd.uniform(.35, .65), size * rnd.uniform(.18, .3)
    def pixel(x, y):
        t = (x + y) / (2 * size)
        base = [int(a[i] * (1 - t) + b[i] * t) for i in range(3)]
        if (x - cx) ** 2 + (y - cy) ** 2 < r * r:
            return (255 - base[0] // 3, 255 - base[1] // 3, 255 - base[2] // 3)
        return base
    return base64.b64encode(png(size, size, pixel)).decode()


def entity(cur, name, table, attrs):
    extra = {"v": 0, "idIsAutoNumber": 2, "attrs": attrs}
    cur.execute("INSERT INTO OSSYS_ENTITY VALUES (?,?,?,?,?,?,0)",
                (str(uuid.UUID(int=random.getrandbits(128))), MODULE, name, table, str(uuid.UUID(int=random.getrandbits(128))), json.dumps(extra)))


def main(out):
    if os.path.exists(out):
        os.remove(out)
    con = sqlite3.connect(out)
    cur = con.cursor()
    cur.executescript("""
        CREATE TABLE "OSSYS_ENTITY" ("SS_Key", "Module_SS_Key", "Name", "Physical_Table_name", "Hash", "Extra_Info", "Upgrade_Status", UNIQUE (SS_Key, Module_SS_Key));
        CREATE TABLE "OSSYS_LOG" ("Instant","LogType","Message","ModuleName","Stack","MessageType","ExtraInfo");
        CREATE TABLE "OSSYS_PERSISTENTKEYVALUE" ('Id' INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, 'Key' UNIQUE NOT NULL, 'Value');
        CREATE TABLE "OSUSR_DEM_LOCALCOUNTRY" ("Id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "Name" TEXT(100) DEFAULT '', "IsoCode" TEXT(2) DEFAULT '');
        CREATE TABLE "OSUSR_DEM_LOCALCUSTOMER" ("Id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "Name" TEXT(100) DEFAULT '', "Email" TEXT(250) DEFAULT '', "City" TEXT(50) DEFAULT '', "LocalCountryId" BIGINT DEFAULT NULL, "IsActive" BOOLEAN DEFAULT 0, "CreatedOn" DATETIME DEFAULT NULL);
        CREATE TABLE "OSUSR_DEM_LOCALCATEGORY" ("Id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "Label" TEXT(50) DEFAULT '');
        CREATE TABLE "OSUSR_DEM_LOCALPRODUCT" ("Id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "Name" TEXT(100) DEFAULT '', "LocalCategoryId" BIGINT DEFAULT NULL, "Price" DECIMAL(37,8) DEFAULT 0, "Photo" BLOB DEFAULT NULL, "IsActive" BOOLEAN DEFAULT 0);
        CREATE TABLE "OSUSR_DEM_LOCALWORKORDER" ("Id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "LocalCustomerId" BIGINT DEFAULT NULL, "Status" TEXT(20) DEFAULT '', "ScheduledOn" DATETIME DEFAULT NULL, "Notes" TEXT(2000) DEFAULT '', "Total" DECIMAL(37,8) DEFAULT 0, "IsSynced" BOOLEAN DEFAULT 0);
        CREATE TABLE "OSUSR_DEM_LOCALWORKORDERITEM" ("Id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "LocalWorkOrderId" BIGINT DEFAULT NULL, "LocalProductId" BIGINT DEFAULT NULL, "Quantity" INT DEFAULT 0, "UnitPrice" DECIMAL(37,8) DEFAULT 0);
        CREATE TABLE "OSUSR_DEM_LOCALSIGNATURE" ("Id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "LocalWorkOrderId" BIGINT DEFAULT NULL, "SignedBy" TEXT(100) DEFAULT '', "Image" BLOB DEFAULT NULL);
        CREATE INDEX "OSIDX_DEM_WORKORDER_CUSTOMER" ON "OSUSR_DEM_LOCALWORKORDER" ("LocalCustomerId");
        CREATE INDEX "OSIDX_DEM_ITEM_ORDER" ON "OSUSR_DEM_LOCALWORKORDERITEM" ("LocalWorkOrderId");
        CREATE TABLE sync_queue (Id TEXT PRIMARY KEY, Sequence INTEGER, Endpoint TEXT, Method TEXT, Payload TEXT, Status TEXT, Retries INTEGER DEFAULT 0, Error TEXT, CreatedAt INTEGER);
        CREATE VIEW "V_OPEN_WORKORDERS" AS
          SELECT w.Id, c.Name AS Customer, w.Status, w.ScheduledOn, w.Total
          FROM OSUSR_DEM_LOCALWORKORDER w JOIN OSUSR_DEM_LOCALCUSTOMER c ON c.Id = w.LocalCustomerId
          WHERE w.Status IN ('Scheduled', 'InProgress');
    """)

    ref = lambda: {"type": 4, "isEntityReference": True}
    txt = lambda n: {"type": 0, "length": n}
    entity(cur, "LocalCountry", "OSUSR_DEM_LOCALCOUNTRY", {"id": {"type": 4, "isPrimaryKey": True, "isEntityReference": True}, "name": txt(100), "isocode": txt(2)})
    entity(cur, "LocalCustomer", "OSUSR_DEM_LOCALCUSTOMER", {"id": {"type": 4, "isPrimaryKey": True, "isEntityReference": True}, "name": txt(100), "email": txt(250), "city": txt(50), "localcountryid": ref(), "isactive": {"type": 2}, "createdon": {"type": 7}})
    entity(cur, "LocalCategory", "OSUSR_DEM_LOCALCATEGORY", {"id": {"type": 4, "isPrimaryKey": True, "isEntityReference": True}, "label": txt(50)})
    entity(cur, "LocalProduct", "OSUSR_DEM_LOCALPRODUCT", {"id": {"type": 4, "isPrimaryKey": True, "isEntityReference": True}, "name": txt(100), "localcategoryid": ref(), "price": {"type": 5}, "photo": {"type": 8}, "isactive": {"type": 2}})
    entity(cur, "LocalWorkOrder", "OSUSR_DEM_LOCALWORKORDER", {"id": {"type": 4, "isPrimaryKey": True, "isEntityReference": True}, "localcustomerid": ref(), "status": txt(20), "scheduledon": {"type": 7}, "notes": txt(2000), "total": {"type": 5}, "issynced": {"type": 2}})
    entity(cur, "LocalWorkOrderItem", "OSUSR_DEM_LOCALWORKORDERITEM", {"id": {"type": 4, "isPrimaryKey": True, "isEntityReference": True}, "localworkorderid": ref(), "localproductid": ref(), "quantity": {"type": 4}, "unitprice": {"type": 5}})
    entity(cur, "LocalSignature", "OSUSR_DEM_LOCALSIGNATURE", {"id": {"type": 4, "isPrimaryKey": True, "isEntityReference": True}, "localworkorderid": ref(), "signedby": txt(100), "image": {"type": 8}})

    cur.executemany("INSERT INTO OSUSR_DEM_LOCALCOUNTRY VALUES (?,?,?)", COUNTRIES)
    cur.executemany("INSERT INTO OSUSR_DEM_LOCALCATEGORY VALUES (?,?)", CATEGORIES)
    for i, (name, cat, price) in enumerate(PRODUCTS, 1):
        cur.execute("INSERT INTO OSUSR_DEM_LOCALPRODUCT VALUES (?,?,?,?,?,?)", (i, name, cat, price, product_image(i), 1 if i % 7 else 0))

    start = datetime(2026, 1, 5, 8, 0)
    for i in range(1, 121):
        first, last = random.choice(FIRST), random.choice(LAST)
        city, country = random.choice(CITIES)
        email = f"{first}.{last}{i}@example.com".lower().encode("ascii", "ignore").decode()
        created = start + timedelta(days=random.randint(0, 240), minutes=random.randint(0, 600))
        cur.execute("INSERT INTO OSUSR_DEM_LOCALCUSTOMER VALUES (?,?,?,?,?,?,?)",
                    (i, f"{first} {last}", email, city, country, 1 if random.random() > .1 else 0, created.strftime("%Y-%m-%d %H:%M:%S")))

    item_id = 1
    for w in range(1, 401):
        status = random.choices(STATUSES, weights=[1, 4, 3, 10, 1])[0]
        when = start + timedelta(days=random.randint(0, 260), hours=random.randint(0, 9))
        total = 0.0
        items = []
        for _ in range(random.randint(1, 5)):
            pid = random.randint(1, len(PRODUCTS))
            qty = random.randint(1, 6)
            price = PRODUCTS[pid - 1][2]
            total += qty * price
            items.append((item_id, w, pid, qty, price))
            item_id += 1
        notes = random.choice(["", "", "Access through the back gate.", "Customer asked for a call 30 min before arrival.",
                               "Replace gasket and test pressure.", "Annual maintenance visit — see checklist in the form."])
        cur.execute("INSERT INTO OSUSR_DEM_LOCALWORKORDER VALUES (?,?,?,?,?,?,?)",
                    (w, random.randint(1, 120), status, when.strftime("%Y-%m-%d %H:%M:%S"), notes, round(total, 2), 1 if status == "Completed" and random.random() > .2 else 0))
        cur.executemany("INSERT INTO OSUSR_DEM_LOCALWORKORDERITEM VALUES (?,?,?,?,?)", items)
        if status == "Completed" and w % 5 == 0:
            cur.execute("INSERT INTO OSUSR_DEM_LOCALSIGNATURE (LocalWorkOrderId, SignedBy, Image) VALUES (?,?,?)",
                        (w, random.choice(FIRST) + " " + random.choice(LAST), product_image(1000 + w, 120)))

    seq = 1
    for w in range(1, 401):
        if random.random() < .12:
            status = random.choice(["pending", "pending", "failed", "completed"])
            payload = json.dumps({"workOrderId": w, "action": "update", "fields": {"Status": random.choice(STATUSES)}})
            cur.execute("INSERT INTO sync_queue VALUES (?,?,?,?,?,?,?,?,?)",
                        (str(uuid.UUID(int=random.getrandbits(128))), seq, "/api/workorders/%d" % w, "PUT", payload, status,
                         random.randint(1, 4) if status == "failed" else 0,
                         "HTTP 409: work order was changed on the server" if status == "failed" else None,
                         1790000000000 + seq * 60000))
            seq += 1

    for k, v in [("LastSyncOn", "2026-09-23T17:42:10Z"), ("AppVersion", "1.4.2"), ("UserLocale", "pt-PT")]:
        cur.execute("INSERT INTO OSSYS_PERSISTENTKEYVALUE (Key, Value) VALUES (?,?)", (k, v))
    for i in range(12):
        cur.execute("INSERT INTO OSSYS_LOG VALUES (?,?,?,?,?,?,?)",
                    ((start + timedelta(days=250, minutes=i * 7)).strftime("%Y-%m-%dT%H:%M:%S"), random.choice(["General", "Error"]),
                     random.choice(["Sync started", "Sync finished", "Timeout calling GetWorkOrders", "Offline data refreshed"]),
                     "FieldService", None, "Client", None))
    con.commit()
    cur.execute("ANALYZE")
    con.commit()
    cur.execute("VACUUM")
    con.close()
    print("wrote", out, os.path.getsize(out), "bytes")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "demo.db")
