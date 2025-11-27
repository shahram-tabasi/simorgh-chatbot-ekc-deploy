"""
Test Script for Enhanced PDF Parser V4
Demonstrates improvements over V3 for handling flat/specification documents
"""

import sys
import json
from pathlib import Path

# Add the parser to path
sys.path.insert(0, '/home/claude')

from enhanced_pdf_parser_v4_universal import EnhancedUniversalPDFParser

def count_sections(structure: dict, count: int = 0) -> int:
    """Recursively count sections."""
    for key, value in structure.items():
        if isinstance(value, dict) and not key.startswith('_'):
            count += 1
            count = count_sections(value, count)
    return count

def analyze_structure(structure: dict, depth: int = 0) -> dict:
    """Analyze structure and return stats."""
    stats = {
        'total_sections': 0,
        'sections_with_content': 0,
        'total_tables': 0,
        'total_content_length': 0,
        'sections_by_level': {},
        'page_sections': 0
    }
    
    def recurse(d: dict, level: int = 0):
        for key, value in d.items():
            if key.startswith('_') or key.startswith('table_'):
                continue
            
            if isinstance(value, dict):
                stats['total_sections'] += 1
                
                # Check level
                section_level = value.get('_section_level', level)
                stats['sections_by_level'][section_level] = stats['sections_by_level'].get(section_level, 0) + 1
                
                # Check content
                if '_raw_content' in value:
                    stats['sections_with_content'] += 1
                    stats['total_content_length'] += len(value['_raw_content'])
                
                # Check if page section
                if key.startswith('page_'):
                    stats['page_sections'] += 1
                
                # Count tables
                table_count = sum(1 for k in value.keys() if k.startswith('table_'))
                stats['total_tables'] += table_count
                
                # Recurse
                recurse(value, level + 1)
    
    recurse(structure)
    return stats

def print_structure_preview(structure: dict, max_sections: int = 5):
    """Print a preview of the structure."""
    print("\n" + "="*60)
    print("STRUCTURE PREVIEW (first {} sections)".format(max_sections))
    print("="*60)
    
    count = 0
    for key, value in structure.items():
        if count >= max_sections:
            break
        
        if isinstance(value, dict) and not key.startswith('_'):
            title = value.get('_section_title', key)
            section_num = value.get('_section_number', '')
            content_len = value.get('_content_length', 0)
            page_num = value.get('_page_number', '')
            
            print(f"\n{count + 1}. {key}")
            print(f"   Title: {title}")
            if section_num:
                print(f"   Number: {section_num}")
            if page_num:
                print(f"   Page: {page_num}")
            print(f"   Content: {content_len} chars")
            
            # Show tables
            tables = [k for k in value.keys() if k.startswith('table_')]
            if tables:
                print(f"   Tables: {len(tables)}")
                for table_key in tables[:2]:  # Show first 2 tables
                    table = value[table_key]
                    shape = table.get('shape', [0, 0])
                    print(f"      - {table_key}: {shape[0]}×{shape[1]}")
            
            count += 1
    
    if count < len([k for k in structure.keys() if not k.startswith('_')]):
        remaining = len([k for k in structure.keys() if not k.startswith('_')]) - count
        print(f"\n   ... and {remaining} more sections")

def test_parser(pdf_path: str):
    """Test the parser on a PDF file."""
    print("\n" + "="*60)
    print(f"TESTING: {pdf_path}")
    print("="*60)
    
    # Initialize parser
    parser = EnhancedUniversalPDFParser(
        strategy="hi_res",
        use_gpu=True,
        extract_tables=True,
        min_content_length=30,  # Lower threshold for more content
        aggressive_filtering=True,
        enable_vector_db=False,  # Disable for testing
    )
    
    try:
        # Parse PDF
        print("\n📄 Parsing PDF...")
        elements, metadata = parser.parse_pdf(pdf_path)
        print(f"   ✓ Extracted {metadata['total_elements']} elements")
        
        # Build structure
        print("\n🔍 Building structure...")
        structure = parser.build_hierarchy_without_ai(elements)
        
        # Analyze structure
        stats = analyze_structure(structure)
        
        print("\n" + "="*60)
        print("RESULTS SUMMARY")
        print("="*60)
        print(f"📊 Total Sections: {stats['total_sections']}")
        print(f"📝 Sections with Content: {stats['sections_with_content']}")
        print(f"📄 Page-based Sections: {stats['page_sections']}")
        print(f"📋 Total Tables: {stats['total_tables']}")
        print(f"📏 Total Content Length: {stats['total_content_length']:,} chars")
        
        print(f"\n📊 Sections by Level:")
        for level in sorted(stats['sections_by_level'].keys()):
            print(f"   Level {level}: {stats['sections_by_level'][level]} sections")
        
        # Show structure preview
        print_structure_preview(structure, max_sections=5)
        
        # Save structure to JSON
        output_path = Path(pdf_path).stem + "_structure.json"
        with open(output_path, 'w', encoding='utf-8') as f:
            json.dump(structure, f, indent=2, ensure_ascii=False)
        print(f"\n✅ Structure saved to: {output_path}")
        
        return structure, stats
        
    except Exception as e:
        print(f"\n❌ Error: {e}")
        import traceback
        traceback.print_exc()
        return None, None

def compare_documents():
    """Compare multiple documents."""
    documents = [
        "/mnt/user-data/uploads/123.pdf",
        "/mnt/user-data/uploads/SPEC.pdf",
    ]
    
    results = {}
    
    for doc_path in documents:
        if Path(doc_path).exists():
            structure, stats = test_parser(doc_path)
            if stats:
                results[Path(doc_path).name] = stats
        else:
            print(f"\n⚠️ File not found: {doc_path}")
    
    # Comparison summary
    if len(results) > 1:
        print("\n" + "="*60)
        print("COMPARISON SUMMARY")
        print("="*60)
        
        for doc_name, stats in results.items():
            print(f"\n{doc_name}:")
            print(f"   Sections: {stats['total_sections']}")
            print(f"   With Content: {stats['sections_with_content']}")
            print(f"   Page Sections: {stats['page_sections']}")
            print(f"   Tables: {stats['total_tables']}")
            print(f"   Content: {stats['total_content_length']:,} chars")

if __name__ == "__main__":
    print("""
╔══════════════════════════════════════════════════════════╗
║   Enhanced PDF Parser V4 - Test Suite                   ║
║   Testing Universal Structure Support                    ║
╚══════════════════════════════════════════════════════════╝
""")
    
    # Test individual document if provided
    if len(sys.argv) > 1:
        pdf_path = sys.argv[1]
        test_parser(pdf_path)
    else:
        # Compare all documents
        compare_documents()
    
    print("\n" + "="*60)
    print("TESTING COMPLETE")
    print("="*60)