# Builds the regional override files (es-419 from es, pt-BR from pt-PT): only texts that differ.
# Run from the repository root after changing es.json or pt-PT.json, then review the result.
import json, re, collections, sys
L='src/renderer/src/i18n/locales/'
def load(f): return json.load(open(L+f), object_pairs_hook=collections.OrderedDict)
def flat(o,p=''):
    for k,v in o.items():
        if isinstance(v,dict): yield from flat(v,p+k+'.')
        else: yield p+k,v
def setp(d,path,v):
    ks=path.split('.')
    for k in ks[:-1]: d=d.setdefault(k,collections.OrderedDict())
    d[ks[-1]]=v
def apply(rules, s):
    for a,b in rules: s=re.sub(a,b,s)
    return s
ES419=[
 (r'Otros ordenadores','Otras computadoras'),(r'\b[Ee]ste ordenador',lambda m:('Esta' if m.group(0)[0]=='E' else 'esta')+' computadora'),
 (r'\botro puerto u ordenador','otro puerto o computadora'),(r'\botro ordenador','otra computadora'),(r'\bcualquier ordenador','cualquier computadora'),
 (r'\bdel ordenador','de la computadora'),(r'\bel ordenador','la computadora'),(r'\btu ordenador','tu computadora'),(r'ordenador','computadora'),
 (r'móvil','celular'),
 (r'Sin añadir','Sin agregar'),(r'añadirlo','agregarlo'),(r'Añadido','Agregado'),(r'añadida','agregada'),(r'añadirá','agregará'),(r'Añadir','Agregar'),(r'Añade','Agrega'),(r'añade','agrega'),
 (r'Ajustes','Configuración'),
 (r'\bImportes\b','Montos'),(r'estos importes','estos montos'),(r'\bImporte\b','Monto'),(r'\bimporte\b','monto'),
 (r'¿Has olvidado la contraseña\?','¿Olvidaste la contraseña?'),(r'Has desbloqueado','Desbloqueaste'),(r'He guardado','Guardé'),
 (r'No se ha encontrado','No se encontró'),(r'no ha podido','no pudo'),(r'ha revisado','revisó'),(r'Algo ha salido mal','Algo salió mal'),
 (r'un USB','una memoria USB'),(r'entra en reposo','entra en suspensión'),(r'^Nómina$','Sueldo'),
]
PTBR=[
 (r'Subscrições','Assinaturas'),(r'subscrições','assinaturas'),(r'\brenda\b','aluguel'),
 (r'^A rever ','Revisando '),(r' revisto: ',' revisado: '),(r'está a rever','está revisando'),
 (r'Também pode adicioná-lo','Você também pode adicioná-lo'),(r'repara quando','percebe quando'),
 (r'palavras-passe','senhas'),(r'[Pp]alavra-passe',lambda m:'Senha' if m.group(0)[0]=='P' else 'senha'),
 (r'ficheiros','arquivos'),(r'[Ff]icheiro',lambda m:'Arquivo' if m.group(0)[0]=='F' else 'arquivo'),
 (r'o ecrã','a tela'),(r'ecrã','tela'),(r'telemóvel','celular'),
 (r'conta de utilizador','conta de usuário'),(r'utilizador','usuário'),
 (r'Definições','Configurações'),
 (r'\bGuardar\b','Salvar'),(r'\bguardar\b','salvar'),(r'Guardei','Salvei'),(r'guardou','salvou'),(r'guardadas','salvas'),(r'[Gg]uardada',lambda m:'Salva' if m.group(0)[0]=='G' else 'salva'),(r'[Gg]uardado',lambda m:'Salvo' if m.group(0)[0]=='G' else 'salvo'),(r'Guarde-a','Salve-a'),(r'guarde-a','salve-a'),(r'Não a guarde','Não a salve'),
 (r'Eliminar','Excluir'),(r'Elimina\b','Exclui'),(r'^Anular$','Desfazer'),
 (r'A descarregar…','Baixando…'),(r'Descarregue','Baixe'),(r'Descarregar','Baixar'),(r'[Dd]escarrega\b',lambda m:'Baixa' if m.group(0)[0]=='D' else 'baixa'),(r'descarregada','baixada'),(r'Última descarga','Último download'),
 (r'A carregar…','Carregando…'),(r'A verificar…','Verificando…'),(r'está a rever','está revisando'),(r'está a trabalhar','está trabalhando'),(r'A procurar','Procurando'),(r'continuam a abrir','continuam abrindo'),(r'continuam a pedir','continuam pedindo'),(r'continuam a aguardar','continuam aguardando'),(r'vai voltar a pedir','vai pedir de novo'),
 (r'Conta à ordem','Conta corrente'),(r'Numerário','Dinheiro'),
 (r'Encriptação','Criptografia'),(r'encriptação','criptografia'),(r'[Ee]ncriptad',lambda m:'Criptografad' if m.group(0)[0]=='E' else 'criptografad'),
 (r'Aspeto','Aparência'),(r'o aspeto','a aparência'),(r'Registe','Registre'),
 (r'Introduza','Digite'),(r'introduzir','digitar'),(r'introduzida','digitada'),(r'Largue aqui','Solte aqui'),
 (r'\bMontantes\b','Valores'),(r'\bmontantes\b','valores'),(r'\bMontante\b','Valor'),(r'\bmontante\b','valor'),(r'um valor como','um valor como'),
 (r'uma pen USB','um pendrive'),(r'Leia este código','Escaneie este código'),(r'Não consegue ler\?','Não consegue escanear?'),
 (r'Subscrições','Assinaturas'),(r'uma subscrição','uma assinatura'),(r'crédito à habitação','financiamento imobiliário'),
 (r'Mudar o nome','Renomear'),(r'^Repor$','Redefinir'),(r'Memorizar','Lembrar'),(r'Memorizado','Lembrado'),(r'memorizado','lembrado'),(r'memoriza\b','lembra'),
 (r'faturação','cobrança'),(r'Faturado','Cobrado'),(r'reforços','aportes'),(r'Comissões','Tarifas'),(r'Escreva-a','Anote-a'),(r'ecrã','tela'),(r'a sua palavra','a sua senha'),
 (r'lê-o e mostra','o lê e mostra'),(r'verifica-a','a verifica'),(r'define-se','é definida'),(r'definem-se à parte','são definidos à parte'),
 (r'O Kasboek pede agora','O Kasboek agora pede'),(r'Bem-vindo ao Kasboek','Boas-vindas ao Kasboek'),(r'Ativa\b(?! )','Ativada'),
 (r'p\. ex\.','ex.:'),
 (r'Património','Patrimônio'),(r'fiável','confiável'),(r'gestor de senhas','gerenciador de senhas'),(r'noutro lado','em outro lugar'),(r'dessa altura','daquela época'),
 (r'\breviu\b','revisou'),(r'Revê tudo','Você revisa tudo'),(r'\brever arquivos','revisar arquivos'),(r'^Rever$','Revisar'),(r'^Rever ','Revisar '),(r'\bRevê\b','Revisa'),(r'\brevê\b','revisa'),(r'Revisto por','Revisado por'),(r'Rever com','Revisar com'),
 (r'Não pode ser anulado','Não pode ser desfeito'),(r'assinala','marca'),(r'levantamentos','saques'),(r'registados','registrados'),
 (r'uma aplicação','um aplicativo'),(r'Uma aplicação','Um aplicativo'),(r'essa aplicação','esse aplicativo'),(r'sua aplicação','seu aplicativo'),(r'\bas aplicações','os aplicativos'),(r'\ba aplicação','o aplicativo'),(r'aplicações','aplicativos'),(r'aplicação','aplicativo'),(r'aplicativo Claude conectada','aplicativo Claude conectado'),(r'^Revisa este CSV do meu banco e importa-o\.$','Revise este CSV do meu banco e importe-o.'),
 (r'\bnum\b','em um'),(r'\bnuma\b','em uma'),(r'\bnoutra\b','em outra'),(r'\bnoutro\b','em outro'),
 (r'Leia este código','Escaneie este código'),(r'Ativa\b(?! )','Ativada'),(r'Aguarde','Aguarde'),(r'Pasta de dados','Pasta de dados'),(r'Ligue','Conecte'),(r'ligada por','conectada via'),(r'ligados a','vinculados a'),(r'ligada a','vinculada a'),
 (r'aplicativo Claude conectada','aplicativo Claude conectado'),(r'a seu aplicativo','o seu aplicativo'),(r'respetiv','respectiv'),(r'^A pensar…$','Pensando…'),(r'^Coloca os meus movimentos sem categoria na categoria certa\.$','Coloque meus movimentos sem categoria na categoria certa.'),(r'\bativ(?=a\b|o\b|ar\b)','ativ'),(r'facto','fato'),(r'contacto','contato'),
]
for base, out, rules in [('es.json','es-419.json',ES419),('pt-PT.json','pt-BR.json',PTBR)]:
    src=load(base); res=collections.OrderedDict()
    for k,v in flat(src):
        n=apply(rules,v)
        if n!=v: setp(res,k,n)
    json.dump(res,open(L+out,'w'),ensure_ascii=False,indent=2); open(L+out,'a').write('\n')
    print(out, sum(1 for _ in flat(res)), 'overrides')
