<#
  Deploy al serviciului AI cloud (cloud/server.ts) in Azure Container Apps, cu ingress INTERN
  (accesibil doar din Backend, niciodata de pe internet).

  Ruleaza din folderul MedFlow-AI, DUPA `az login`:
    .\deploy\azure\deploy.ps1 -Registry medflowacr12345

  Ordinea: intai acest script (AI), apoi scriptul din MedFlow-Backend, care are nevoie de adresa AI-ului.
  Cerinte, cine face ce si cum se urca imaginea: deploy\azure\README.md
#>
param(
  # Numele registry-ului de imagini (Azure Container Registry). Unic in tot Azure, doar litere mici si cifre.
  [Parameter(Mandatory = $true)] [string] $Registry,
  [string] $ResourceGroup = "medflow-rg",
  # Unele abonamente Azure for Students permit doar anumite regiuni: daca primesti o eroare de "policy", schimba-o.
  [string] $Location = "westeurope",
  [string] $Environment = "medflow-env",
  # Implicit: commit-ul curent (git rev-parse --short HEAD), ca imaginea urcata si cea folosita sa fie aceeasi.
  [string] $ImageTag = "",
  # Construieste imaginea in Azure (az acr build). Pe Azure for Students de obicei NU e permis (TasksOperationsNotAllowed).
  [switch] $BuildInAzure,
  # Construieste imaginea cu Docker pe ACEST calculator si o urca in registry (merge si pe Azure for Students).
  [switch] $BuildLocally
)

$AppName = "medflow-ai"
$ImageName = "medflow-ai"
$TargetPort = 8091
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path

# Ruleaza o comanda az si se opreste daca az raporteaza o eroare.
# Nu afisam argumentele: pot contine chei secrete.
function Invoke-Az {
  az @args
  if ($LASTEXITCODE -ne 0) { throw "Comanda 'az $($args[0]) $($args[1])' a esuat (cod $LASTEXITCODE). Vezi mesajul de mai sus." }
}

# Intoarce $true daca resursa exista (comanda `az ... show` reuseste).
function Test-Az {
  az @args --only-show-errors -o none 2>$null | Out-Null
  return ($LASTEXITCODE -eq 0)
}

Write-Host "== 1. Verific contul Azure"
if (-not (Test-Az account show)) { throw "Nu esti logat in Azure CLI. Ruleaza intai: az login" }
Invoke-Az extension add --name containerapp --upgrade --only-show-errors
foreach ($provider in "Microsoft.App", "Microsoft.OperationalInsights", "Microsoft.ContainerRegistry") {
  Invoke-Az provider register --namespace $provider --wait --only-show-errors
}

Write-Host "== 2. Resursele comune (le creeaza doar daca lipsesc; acelasi bloc e si in scriptul Backend)"
# Grupul e doar un "dosar" pentru resurse; resursele din el pot fi in alta regiune decat grupul.
# Il cream doar daca lipseste (altfel `group create` cu alta regiune da eroare).
if (-not (Test-Az group show --name $ResourceGroup)) {
  Invoke-Az group create --name $ResourceGroup --location $Location -o none
}
if (-not (Test-Az acr show --name $Registry --resource-group $ResourceGroup)) {
  # --location explicit: altfel registry-ul ia regiunea grupului, care poate fi alta decat $Location.
  Invoke-Az acr create --name $Registry --resource-group $ResourceGroup --location $Location --sku Basic --admin-enabled true -o none
} else {
  Invoke-Az acr update --name $Registry --admin-enabled true -o none
}
if (-not (Test-Az containerapp env show --name $Environment --resource-group $ResourceGroup)) {
  Invoke-Az containerapp env create --name $Environment --resource-group $ResourceGroup --location $Location -o none
}

Write-Host "== 3. Imaginea"
if ($ImageTag -eq "") { $ImageTag = (git -C $RepoRoot rev-parse --short HEAD) }
$RegistryServer = "$Registry.azurecr.io"
$Image = "$RegistryServer/${ImageName}:$ImageTag"
if ($BuildInAzure) {
  Invoke-Az acr build --registry $Registry --image "${ImageName}:$ImageTag" $RepoRoot
}
if ($BuildLocally) {
  # az acr login da Docker-ului dreptul sa urce imagini in registry (Docker Desktop trebuie sa fie pornit).
  Invoke-Az acr login --name $Registry
  docker build -t $Image $RepoRoot
  if ($LASTEXITCODE -ne 0) { throw "docker build a esuat (cod $LASTEXITCODE)." }
  docker push $Image
  if ($LASTEXITCODE -ne 0) { throw "docker push a esuat (cod $LASTEXITCODE)." }
}
if (-not (Test-Az acr repository show --name $Registry --image "${ImageName}:$ImageTag")) {
  Write-Host ""
  Write-Host "Imaginea $Image nu exista in registry."
  Write-Host "Cineva cu Docker functional o urca (vezi deploy\azure\README.md, pasul 'Urcarea imaginii'), apoi rulezi din nou scriptul."
  exit 1
}

Write-Host "== 4. Cheia Gemini (secret in Container Apps, nu apare in log-uri)"
$GeminiKey = $env:GEMINI_API_KEY
if (-not $GeminiKey) {
  $secure = Read-Host "GEMINI_API_KEY" -AsSecureString
  $GeminiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}
if (-not $GeminiKey) { throw "GEMINI_API_KEY lipseste. Ruleaza scriptul intr-o fereastra PowerShell obisnuita si lipeste cheia cand e ceruta." }

Write-Host "== 5. Aplicatia $AppName"
$RegistryUser = az acr credential show --name $Registry --query username -o tsv
$RegistryPassword = az acr credential show --name $Registry --query "passwords[0].value" -o tsv
if (-not (Test-Az containerapp show --name $AppName --resource-group $ResourceGroup)) {
  Invoke-Az containerapp create --name $AppName --resource-group $ResourceGroup --environment $Environment `
    --image $Image --registry-server $RegistryServer --registry-username $RegistryUser --registry-password $RegistryPassword `
    --ingress internal --target-port $TargetPort --min-replicas 0 --max-replicas 1 `
    --secrets "gemini-api-key=$GeminiKey" --env-vars "GEMINI_API_KEY=secretref:gemini-api-key" -o none
} else {
  Invoke-Az containerapp secret set --name $AppName --resource-group $ResourceGroup --secrets "gemini-api-key=$GeminiKey" -o none
  Invoke-Az containerapp update --name $AppName --resource-group $ResourceGroup --image $Image -o none
}

$Fqdn = az containerapp show --name $AppName --resource-group $ResourceGroup --query properties.configuration.ingress.fqdn -o tsv
Write-Host ""
Write-Host "Gata. Serviciul AI ruleaza intern la: https://$Fqdn"
Write-Host "Scriptul din MedFlow-Backend il gaseste singur (AI_URL). De pe internet NU e accesibil, si e corect asa."
