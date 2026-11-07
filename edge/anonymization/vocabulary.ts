/**
 * Closed vocabularies for the anonymized patient summary.
 *
 * Only a term listed here can ever leave the laptop. Free text never does: a patient name, an address
 * or any other word that is not in these lists simply cannot be expressed in the summary.
 *
 * Each entry is [canonical term shown to the AI, ...aliases]. Aliases are matched after normalization
 * (lowercase, no diacritics, punctuation as spaces), as whole words. Brand names point to the active
 * substance. This is a first, deliberately small list: a term that is missing stays local (it is only
 * counted in `omittedItemCount`), it is never sent. Extend it after review by a medical person.
 */

export type VocabularyEntry = readonly [canonical: string, ...aliases: string[]];

/** Lowercase, strip diacritics, turn punctuation into single spaces. */
export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export const SUBSTANCES: readonly VocabularyEntry[] = [
  ['paracetamol', 'paracetamol', 'panadol', 'efferalgan', 'acetaminofen'],
  ['ibuprofen', 'ibuprofen', 'nurofen', 'advil'],
  ['aspirină', 'aspirina', 'acid acetilsalicilic', 'aspenter', 'cardioaspirin'],
  ['diclofenac', 'diclofenac', 'voltaren'],
  ['metamizol', 'metamizol', 'algocalmin', 'novalgin'],
  ['drotaverină', 'drotaverina', 'no spa', 'nospa'],
  ['amlodipină', 'amlodipina', 'amlodipine', 'norvasc', 'tenox'],
  ['bisoprolol', 'bisoprolol', 'concor'],
  ['metoprolol', 'metoprolol'],
  ['carvedilol', 'carvedilol'],
  ['enalapril', 'enalapril'],
  ['lisinopril', 'lisinopril'],
  ['ramipril', 'ramipril', 'tritace'],
  ['perindopril', 'perindopril', 'prestarium'],
  ['losartan', 'losartan', 'cozaar'],
  ['valsartan', 'valsartan'],
  ['telmisartan', 'telmisartan'],
  ['hidroclorotiazidă', 'hidroclorotiazida', 'hidroclorotiazid', 'hctz'],
  ['indapamidă', 'indapamida', 'indapamid'],
  ['furosemid', 'furosemid', 'furosemida'],
  ['spironolactonă', 'spironolactona', 'spironolacton'],
  ['atorvastatină', 'atorvastatina', 'atorvastatin', 'sortis'],
  ['rosuvastatină', 'rosuvastatina', 'rosuvastatin', 'crestor'],
  ['simvastatină', 'simvastatina', 'simvastatin'],
  ['metformin', 'metformin', 'metformina', 'glucophage', 'siofor'],
  ['gliclazidă', 'gliclazida', 'gliclazid', 'diaprel'],
  ['glimepiridă', 'glimepirida', 'glimepirid', 'amaryl'],
  ['insulină', 'insulina', 'insulin'],
  ['empagliflozin', 'empagliflozin', 'jardiance'],
  ['omeprazol', 'omeprazol', 'omeprazole'],
  ['pantoprazol', 'pantoprazol', 'controloc'],
  ['esomeprazol', 'esomeprazol', 'nexium'],
  ['levotiroxină', 'levotiroxina', 'levotiroxin', 'euthyrox', 'letrox'],
  ['amoxicilină', 'amoxicilina', 'amoxicillin', 'amoxil'],
  ['amoxicilină cu acid clavulanic', 'amoxicilina acid clavulanic', 'augmentin', 'amoxiclav'],
  ['azitromicină', 'azitromicina', 'azitromicin', 'sumamed'],
  ['claritromicină', 'claritromicina', 'claritromicin'],
  ['ciprofloxacină', 'ciprofloxacina', 'ciprofloxacin'],
  ['cefuroximă', 'cefuroxima', 'cefuroxim', 'zinnat'],
  ['doxiciclină', 'doxiciclina', 'doxiciclin'],
  ['metronidazol', 'metronidazol'],
  ['nitrofurantoin', 'nitrofurantoin'],
  ['fluconazol', 'fluconazol'],
  ['acyclovir', 'aciclovir', 'acyclovir'],
  ['loratadină', 'loratadina', 'loratadin', 'claritine'],
  ['cetirizină', 'cetirizina', 'cetirizin', 'zyrtec'],
  ['salbutamol', 'salbutamol', 'ventolin'],
  ['budesonidă', 'budesonida', 'budesonid'],
  ['prednison', 'prednison'],
  ['prednisolon', 'prednisolon'],
  ['dexametazonă', 'dexametazona', 'dexametazon'],
  ['clopidogrel', 'clopidogrel', 'plavix'],
  ['warfarină', 'warfarina', 'warfarin'],
  ['acenocumarol', 'acenocumarol', 'sintrom'],
  ['rivaroxaban', 'rivaroxaban', 'xarelto'],
  ['apixaban', 'apixaban', 'eliquis'],
  ['digoxin', 'digoxin'],
  ['amiodaronă', 'amiodarona', 'amiodaron'],
  ['nitroglicerină', 'nitroglicerina', 'nitroglicerin'],
  ['alprazolam', 'alprazolam', 'xanax'],
  ['diazepam', 'diazepam'],
  ['sertralină', 'sertralina', 'sertralin'],
  ['escitalopram', 'escitalopram'],
  ['tramadol', 'tramadol'],
  ['gabapentin', 'gabapentin'],
  ['allopurinol', 'alopurinol', 'allopurinol'],
  ['colchicină', 'colchicina', 'colchicin'],
  ['vitamina D', 'vitamina d', 'colecalciferol'],
  ['vitamina C', 'vitamina c', 'acid ascorbic'],
  ['fier', 'fier', 'sulfat feros', 'ferro'],
  ['acid folic', 'acid folic'],
  ['magneziu', 'magneziu'],
  ['potasiu', 'potasiu'],
];

export const CONDITIONS: readonly VocabularyEntry[] = [
  ['hipertensiune arterială', 'hipertensiune arteriala', 'hipertensiune', 'hta', 'tensiune arteriala mare'],
  ['diabet zaharat', 'diabet zaharat', 'diabet', 'diabetic'],
  ['dislipidemie', 'dislipidemie', 'colesterol mare', 'hipercolesterolemie', 'hiperlipidemie'],
  ['astm bronșic', 'astm bronsic', 'astm'],
  ['BPOC', 'bpoc', 'bronhopneumopatie obstructiva cronica'],
  ['insuficiență cardiacă', 'insuficienta cardiaca'],
  ['fibrilație atrială', 'fibrilatie atriala'],
  ['boală coronariană', 'boala coronariana', 'cardiopatie ischemica', 'angina pectorala'],
  ['infarct miocardic', 'infarct miocardic', 'infarct'],
  ['accident vascular cerebral', 'accident vascular cerebral', 'avc'],
  ['hipotiroidism', 'hipotiroidism', 'tiroidita hashimoto'],
  ['hipertiroidism', 'hipertiroidism'],
  ['boală cronică de rinichi', 'boala cronica de rinichi', 'insuficienta renala', 'boala renala cronica'],
  ['gastrită', 'gastrita'],
  ['ulcer gastroduodenal', 'ulcer gastric', 'ulcer duodenal', 'ulcer gastroduodenal'],
  ['reflux gastroesofagian', 'reflux gastroesofagian', 'reflux', 'rgeb'],
  ['migrenă', 'migrena', 'migrene'],
  ['epilepsie', 'epilepsie'],
  ['depresie', 'depresie'],
  ['anxietate', 'anxietate', 'tulburare anxioasa'],
  ['artroză', 'artroza', 'gonartroza', 'coxartroza'],
  ['osteoporoză', 'osteoporoza'],
  ['anemie', 'anemie', 'anemie feripriva'],
  ['obezitate', 'obezitate'],
  ['infecție urinară', 'infectie urinara', 'infectie de tract urinar', 'cistita'],
  ['faringită', 'faringita', 'faringita acuta'],
  ['amigdalită', 'amigdalita'],
  ['bronșită', 'bronsita'],
  ['pneumonie', 'pneumonie'],
  ['sinuzită', 'sinuzita'],
  ['gripă', 'gripa'],
  ['COVID-19', 'covid 19', 'covid', 'sars cov 2'],
  ['gută', 'guta'],
  ['hipertrofie benignă de prostată', 'hipertrofie benigna de prostata', 'adenom de prostata'],
  ['durere lombară', 'durere lombara', 'lombalgie'],
  ['alergie sezonieră', 'rinita alergica', 'alergie sezoniera'],
  ['hepatită cronică', 'hepatita cronica', 'hepatita b', 'hepatita c'],
  ['ciroză hepatică', 'ciroza hepatica', 'ciroza'],
  ['cancer', 'cancer', 'neoplasm', 'tumora maligna'],
];

export const ALLERGENS: readonly VocabularyEntry[] = [
  ['penicilină', 'penicilina', 'penicilin'],
  ['amoxicilină', 'amoxicilina', 'amoxicillin'],
  ['sulfamide', 'sulfamide', 'sulfonamide'],
  ['aspirină', 'aspirina', 'acid acetilsalicilic'],
  ['antiinflamatoare nesteroidiene', 'antiinflamatoare', 'aine', 'ibuprofen', 'diclofenac'],
  ['iod', 'iod', 'substanta de contrast iodata'],
  ['latex', 'latex'],
  ['polen', 'polen'],
  ['praf', 'praf', 'acarieni'],
  ['mucegai', 'mucegai'],
  ['păr de animale', 'par de animale', 'par de pisica', 'par de caine'],
  ['lapte', 'lapte', 'proteine din laptele de vaca'],
  ['ouă', 'oua', 'ou'],
  ['arahide', 'arahide', 'alune de pamant'],
  ['nuci', 'nuci', 'alune', 'migdale'],
  ['fructe de mare', 'fructe de mare', 'crustacee', 'pesti'],
  ['gluten', 'gluten'],
  ['înțepătură de insectă', 'intepatura de albina', 'intepatura de viespe', 'intepaturi de insecte'],
];

export type LabTestEntry = readonly [canonical: string, ...aliases: string[]];

export const LAB_TESTS: readonly LabTestEntry[] = [
  ['hemoglobină', 'hemoglobina', 'hgb', 'hb'],
  ['hematocrit', 'hematocrit', 'hct'],
  ['leucocite', 'leucocite', 'wbc'],
  ['trombocite', 'trombocite', 'plt'],
  ['eritrocite', 'eritrocite', 'rbc'],
  ['glicemie', 'glicemie', 'glucoza', 'glicemie a jeun'],
  ['hemoglobină glicozilată', 'hemoglobina glicozilata', 'hba1c', 'hemoglobina glicata'],
  ['colesterol total', 'colesterol total', 'cholesterol total'],
  ['colesterol LDL', 'ldl', 'colesterol ldl'],
  ['colesterol HDL', 'hdl', 'colesterol hdl'],
  ['trigliceride', 'trigliceride'],
  ['creatinină', 'creatinina'],
  ['uree', 'uree'],
  ['acid uric', 'acid uric'],
  ['TGO (AST)', 'tgo', 'ast'],
  ['TGP (ALT)', 'tgp', 'alt'],
  ['TSH', 'tsh'],
  ['proteina C reactivă', 'proteina c reactiva', 'crp'],
  ['VSH', 'vsh'],
  ['sodiu', 'sodiu', 'na'],
  ['potasiu', 'potasiu', 'k'],
  ['fier seric', 'fier seric', 'sideremie'],
  ['feritină', 'feritina'],
  ['vitamina D', 'vitamina d', '25 oh vitamina d'],
];

export type Lookup = ReadonlyMap<string, string>;

/** alias (normalized) -> canonical term. */
export function buildLookup(entries: readonly VocabularyEntry[]): Lookup {
  const lookup = new Map<string, string>();
  for (const [canonical, ...aliases] of entries) {
    for (const alias of [canonical, ...aliases]) lookup.set(normalize(alias), canonical);
  }
  return lookup;
}

export const SUBSTANCE_LOOKUP = buildLookup(SUBSTANCES);
export const CONDITION_LOOKUP = buildLookup(CONDITIONS);
export const ALLERGEN_LOOKUP = buildLookup(ALLERGENS);
export const LAB_TEST_LOOKUP = buildLookup(LAB_TESTS);

const toSet = (entries: readonly VocabularyEntry[]) => new Set(entries.map(([canonical]) => canonical));
export const SUBSTANCE_TERMS = toSet(SUBSTANCES);
export const CONDITION_TERMS = toSet(CONDITIONS);
export const ALLERGEN_TERMS = toSet(ALLERGENS);
export const LAB_TEST_TERMS = toSet(LAB_TESTS);
