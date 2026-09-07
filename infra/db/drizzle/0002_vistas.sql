-- ═══════════════════════════════════════════════════════════════════════════
-- Infra-estrutura das vistas geradas (ESPECIFICACAO.md §3, opção C).
--
-- Nada aqui é por formulário. Isto é o terreno onde as vistas de cada
-- formulário publicado assentam: um esquema próprio e um punhado de funções de
-- conversão. As vistas em si nascem e morrem no pipeline de publicação
-- (restrição inegociável 5: nenhum DDL por formulário além das vistas).
--
-- Porquê funções de conversão em vez de `::integer` directo: um único valor mal
-- escrito no JSONB — uma revisão gravada por uma versão antiga da app, um
-- registo importado à mão — faria a vista INTEIRA rebentar ao ser consultada.
-- Não se perderia o dado, mas perder-se-ia o acesso a todos os outros, que na
-- prática é o mesmo enquanto ninguém tem tempo de investigar. Estas funções
-- devolvem NULL nesse caso e a vista continua a responder.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE SCHEMA IF NOT EXISTS cvf_views;
--> statement-breakpoint

COMMENT ON SCHEMA cvf_views IS
  'Vistas tipadas geradas ao publicar cada versão de formulário. Criadas e apagadas pelo pipeline de publicação; nunca editadas à mão.';
--> statement-breakpoint

-- ── Conversões seguras de JSONB ────────────────────────────────────────────

-- Texto: `#>> '{}'` desembrulha qualquer escalar sem as aspas do `::text`.
CREATE OR REPLACE FUNCTION cvf_views.to_text(v jsonb) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN v IS NULL OR jsonb_typeof(v) = 'null' THEN NULL ELSE v #>> '{}' END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION cvf_views.to_integer(v jsonb) RETURNS integer
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
BEGIN
  RETURN cvf_views.to_text(v)::integer;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION cvf_views.to_numeric(v jsonb) RETURNS numeric
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
BEGIN
  RETURN cvf_views.to_text(v)::numeric;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION cvf_views.to_boolean(v jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
BEGIN
  RETURN cvf_views.to_text(v)::boolean;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION cvf_views.to_date(v jsonb) RETURNS date
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
BEGIN
  RETURN cvf_views.to_text(v)::date;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION cvf_views.to_time(v jsonb) RETURNS time
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
BEGIN
  RETURN cvf_views.to_text(v)::time;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;
--> statement-breakpoint

-- Tudo o que é instante é guardado e devolvido em UTC (ESPECIFICACAO §13.9).
CREATE OR REPLACE FUNCTION cvf_views.to_timestamptz(v jsonb) RETURNS timestamptz
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
BEGIN
  RETURN cvf_views.to_text(v)::timestamptz;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION cvf_views.to_uuid(v jsonb) RETURNS uuid
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
BEGIN
  RETURN cvf_views.to_text(v)::uuid;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;
--> statement-breakpoint

-- `select_multiple` e anexos: array de texto. Aceita também a forma ODK, com
-- os valores separados por espaço, para os registos que venham de importação.
CREATE OR REPLACE FUNCTION cvf_views.to_text_array(v jsonb) RETURNS text[]
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
BEGIN
  IF v IS NULL OR jsonb_typeof(v) = 'null' THEN
    RETURN NULL;
  ELSIF jsonb_typeof(v) = 'array' THEN
    RETURN ARRAY(SELECT jsonb_array_elements_text(v));
  ELSE
    RETURN string_to_array(cvf_views.to_text(v), ' ');
  END IF;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;
--> statement-breakpoint

-- ── Geometria ──────────────────────────────────────────────────────────────

-- Um geopoint é `{lat, lon, alt, accuracy_m, fix_type, source}`. A geometria
-- canónica é geometry(Point,4326) — não geography — para o QGIS não precisar
-- de cast nenhum (ADR-0009).
CREATE OR REPLACE FUNCTION cvf_views.to_point(v jsonb) RETURNS geometry(Point, 4326)
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  lat double precision;
  lon double precision;
BEGIN
  IF v IS NULL OR jsonb_typeof(v) <> 'object' THEN RETURN NULL; END IF;
  lat := (v ->> 'lat')::double precision;
  lon := (v ->> 'lon')::double precision;
  IF lat IS NULL OR lon IS NULL THEN RETURN NULL; END IF;
  RETURN ST_SetSRID(ST_MakePoint(lon, lat), 4326);
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;
--> statement-breakpoint

-- Um geotrace é `{vertices: [{lat, lon}, ...]}`. Menos de dois vértices não é
-- uma linha, e devolver NULL é melhor do que uma geometria inválida que só dá
-- erro mais tarde, dentro do QGIS de outra pessoa.
CREATE OR REPLACE FUNCTION cvf_views.to_linestring(v jsonb) RETURNS geometry(LineString, 4326)
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  pontos geometry[];
BEGIN
  IF v IS NULL OR jsonb_typeof(v) <> 'object' THEN RETURN NULL; END IF;
  SELECT ARRAY(
    SELECT ST_SetSRID(ST_MakePoint((e ->> 'lon')::double precision, (e ->> 'lat')::double precision), 4326)
    FROM jsonb_array_elements(v -> 'vertices') AS e
    WHERE (e ->> 'lat') IS NOT NULL AND (e ->> 'lon') IS NOT NULL
  ) INTO pontos;
  IF array_length(pontos, 1) < 2 THEN RETURN NULL; END IF;
  RETURN ST_SetSRID(ST_MakeLine(pontos), 4326);
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;
--> statement-breakpoint

-- Um geoshape fecha-se sozinho se o técnico não fechou o polígono no terreno,
-- que é o que acontece na prática.
CREATE OR REPLACE FUNCTION cvf_views.to_polygon(v jsonb) RETURNS geometry(Polygon, 4326)
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  pontos geometry[];
  anel geometry;
BEGIN
  IF v IS NULL OR jsonb_typeof(v) <> 'object' THEN RETURN NULL; END IF;
  SELECT ARRAY(
    SELECT ST_SetSRID(ST_MakePoint((e ->> 'lon')::double precision, (e ->> 'lat')::double precision), 4326)
    FROM jsonb_array_elements(v -> 'vertices') AS e
    WHERE (e ->> 'lat') IS NOT NULL AND (e ->> 'lon') IS NOT NULL
  ) INTO pontos;
  IF array_length(pontos, 1) < 3 THEN RETURN NULL; END IF;
  IF NOT ST_Equals(pontos[1], pontos[array_length(pontos, 1)]) THEN
    pontos := pontos || pontos[1];
  END IF;
  anel := ST_SetSRID(ST_MakeLine(pontos), 4326);
  RETURN ST_MakePolygon(anel);
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;
