export const pharmacyBrand = {
  name: "FarmaWorld San Gerardo C.A.",
  logo: "/farmaworld-logo.jpeg",
  rif: "J-41151592-2",
};

export function pharmacyDisplayName(name?: string) {
  const configured = name?.trim();
  return configured && configured !== "Farmacia La Grita" ? configured : pharmacyBrand.name;
}
