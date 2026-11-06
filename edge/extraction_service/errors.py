class ExtractionError(Exception):
    """O problemă care oprește extragerea. `status_code` e codul HTTP cu care răspundem.

      400 = fișier gol                       415 = nu e JPG / PNG / PDF
      413 = fișier prea mare                 422 = fișierul e valid, dar nu are text de citit
      502 = MedGemma a răspuns greșit        503 = Ollama / modelul nu e disponibil
      504 = MedGemma nu a răspuns la timp
    """

    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.message = message
