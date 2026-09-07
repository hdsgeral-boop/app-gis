/**
 * Distância geodésica em metros sobre o elipsóide WGS84 (Vincenty inverso).
 *
 * Porquê não a fórmula de haversine, que é metade das linhas: a haversine
 * assume uma esfera e erra até ~0,5 % consoante a latitude e a orientação —
 * numa distância de 50 km isso são 250 m. Um `constraint` do género «o ponto
 * tem de estar a menos de 500 m do PT» decidido com esse erro é um defeito de
 * dados no terreno, e ninguém o vai atribuir à fórmula.
 *
 * O Vincenty não converge em pontos quase antipodais; nesse caso caímos na
 * haversine, porque a essa escala o erro relativo deixa de importar para
 * qualquer uso real de um formulário.
 */

const A = 6378137.0; // semi-eixo maior, WGS84
const F = 1 / 298.257223563; // achatamento
const B = (1 - F) * A; // semi-eixo menor

const RAD = Math.PI / 180;

export interface LatLon {
  lat: number;
  lon: number;
}

export function distanceMeters(p1: LatLon, p2: LatLon): number {
  const vincenty = vincentyInverse(p1, p2);
  return vincenty ?? haversine(p1, p2);
}

function vincentyInverse(p1: LatLon, p2: LatLon): number | undefined {
  const L = (p2.lon - p1.lon) * RAD;
  const U1 = Math.atan((1 - F) * Math.tan(p1.lat * RAD));
  const U2 = Math.atan((1 - F) * Math.tan(p2.lat * RAD));
  const sinU1 = Math.sin(U1);
  const cosU1 = Math.cos(U1);
  const sinU2 = Math.sin(U2);
  const cosU2 = Math.cos(U2);

  let lambda = L;
  let sinSigma = 0;
  let cosSigma = 0;
  let sigma = 0;
  let cos2SigmaM = 0;
  let cosSqAlpha = 0;

  for (let i = 0; i < 200; i++) {
    const sinLambda = Math.sin(lambda);
    const cosLambda = Math.cos(lambda);
    sinSigma = Math.sqrt(
      (cosU2 * sinLambda) ** 2 + (cosU1 * sinU2 - sinU1 * cosU2 * cosLambda) ** 2,
    );
    if (sinSigma === 0) return 0; // pontos coincidentes
    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
    sigma = Math.atan2(sinSigma, cosSigma);
    const sinAlpha = (cosU1 * cosU2 * sinLambda) / sinSigma;
    cosSqAlpha = 1 - sinAlpha * sinAlpha;
    // Em linhas equatoriais cosSqAlpha é 0 e cos2SigmaM fica indefinido:
    // a convenção é tratá-lo como 0.
    cos2SigmaM = cosSqAlpha === 0 ? 0 : cosSigma - (2 * sinU1 * sinU2) / cosSqAlpha;
    const C = (F / 16) * cosSqAlpha * (4 + F * (4 - 3 * cosSqAlpha));
    const lambdaPrev = lambda;
    lambda =
      L +
      (1 - C) *
        F *
        sinAlpha *
        (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)));
    if (Math.abs(lambda - lambdaPrev) < 1e-12) {
      const uSq = (cosSqAlpha * (A * A - B * B)) / (B * B);
      const k1 = (Math.sqrt(1 + uSq) - 1) / (Math.sqrt(1 + uSq) + 1);
      const AA = (1 + (k1 * k1) / 4) / (1 - k1);
      const BB = k1 * (1 - (3 * k1 * k1) / 8);
      const deltaSigma =
        BB *
        sinSigma *
        (cos2SigmaM +
          (BB / 4) *
            (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
              (BB / 6) *
                cos2SigmaM *
                (-3 + 4 * sinSigma * sinSigma) *
                (-3 + 4 * cos2SigmaM * cos2SigmaM)));
      return B * AA * (sigma - deltaSigma);
    }
  }
  return undefined; // não convergiu: quase antipodal
}

function haversine(p1: LatLon, p2: LatLon): number {
  const R = 6371008.8; // raio médio da Terra
  const dLat = (p2.lat - p1.lat) * RAD;
  const dLon = (p2.lon - p1.lon) * RAD;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(p1.lat * RAD) * Math.cos(p2.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
