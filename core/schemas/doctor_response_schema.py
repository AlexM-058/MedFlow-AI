from typing import List, Optional
from pydantic import BaseModel, Field, validator

class MedicalOption(BaseModel):
    option: str = Field(..., description="The proposed differential diagnosis or next step")
    reasoning: str = Field(..., description="Evidence-based arguments supporting this option")
    confidence: str = Field(..., description="Confidence level or uncertainty notes")
    confirmation_path: str = Field(..., description="Tests or info needed to confirm/rule out this option")

class CaseSummary(BaseModel):
    chief_complaint: str = Field(..., description="The primary reason for the visit")
    onset: str = Field(..., description="When the symptoms started")
    duration: str = Field(..., description="How long symptoms have lasted")
    pattern: str = Field(..., description="Nature of symptoms (e.g., constant, intermittent)")
    severity: int = Field(..., ge=0, le=10, description="Severity scale 0-10")
    associated_symptoms: List[str] = Field(default_factory=list)
    relevant_history: List[str] = Field(default_factory=list, description="Medications, allergies, chronic conditions")
    red_flags_detected: bool = Field(default=False)

class DoctorAIResponse(BaseModel):
    case_summary: CaseSummary
    preliminary_options: List[MedicalOption] = Field(..., min_items=3, max_items=3, description="Exactly 3 argued options")
    follow_up_questions: List[str] = Field(..., description="Specific questions the doctor should ask the patient")

    @validator('preliminary_options')
    def check_exactly_three(cls, v):
        if len(v) != 3:
            raise ValueError('Doctor AI must provide exactly 3 preliminary options')
        return v

# Example validation usage
if __name__ == "__main__":
    try:
        example_data = {
            "case_summary": {
                "chief_complaint": "Chest tightness",
                "onset": "2 hours ago",
                "duration": "Constant",
                "pattern": "Worsening",
                "severity": 7,
                "associated_symptoms": ["Shortness of breath", "Nausea"],
                "relevant_history": ["Hypertension", "Smoker"],
                "red_flags_detected": True
            },
            "preliminary_options": [
                {
                    "option": "Acute Coronary Syndrome",
                    "reasoning": "Chest tightness combined with nausea and hypertension history.",
                    "confidence": "High",
                    "confirmation_path": "EKG and Troponin levels"
                },
                {
                    "option": "Pulmonary Embolism",
                    "reasoning": "Shortness of breath and acute onset.",
                    "confidence": "Medium",
                    "confirmation_path": "CT Pulmonary Angiogram"
                },
                {
                    "option": "Gastroesophageal Reflux Disease (GERD)",
                    "reasoning": "Chest discomfort can often mimic cardiac pain.",
                    "confidence": "Low",
                    "confirmation_path": "PPI trial or Endoscopy"
                }
            ],
            "follow_up_questions": [
                "Does the pain radiate to the left arm or jaw?",
                "Have you had similar episodes in the past?"
            ]
        }
        validated = DoctorAIResponse(**example_data)
        print("✅ JSON Validation Successful")
    except Exception as e:
        print(f"❌ Validation Failed: {e}")
